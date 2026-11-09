#!/usr/bin/env bash
# Деплой «Практики» на свой сервер (Ubuntu + nginx + certbot + python3-cryptography). Идемпотентный.
# Параметры — в deploy.env рядом со скриптом (не в git, образец — deploy.env.example) или в переменных окружения.
#  1) заливает файлы приложения в /var/www/$SLUG
#  2) ставит nginx-вхост: только http, пока нет сертификата; полный https, когда он есть
#  3) если DNS уже смотрит на droplet и сертификата нет — выпускает его (certbot webroot)
set -euo pipefail

# ===== параметры =====
SRC="$(cd "$(dirname "$0")" && pwd)"
[ -f "$SRC/deploy.env" ] && . "$SRC/deploy.env"
HOST="${HOST:?задай HOST (домен сайта) в deploy.env}"
SLUG="${SLUG:-practice}"
DROPLET="${DROPLET:?задай DROPLET (user@сервер) в deploy.env}"
DROPLET_IP="${DROPLET_IP:?задай DROPLET_IP в deploy.env}"
KEY="${KEY:-$HOME/.ssh/id_ed25519}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
SSH=(ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "$DROPLET")

log() { printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2"; }

log INFO "deploy $SRC → $DROPLET:/var/www/$SLUG ($HOST)"

# 1) файлы
rsync -az --delete -e "ssh -i $KEY -o BatchMode=yes" \
  --include='index.html' --include='app.js' --include='style.css' --include='sw.js' \
  --include='manifest.webmanifest' --include='icons/' --include='icons/*.png' --exclude='*' \
  "$SRC/" "$DROPLET:/var/www/$SLUG/"
log INFO "files synced"

# 1б) пуш-сервис (вибро): код в /opt/nhc-push, systemd-юнит; рестарт только если что-то поменялось
rsync -az -e "ssh -i $KEY -o BatchMode=yes" "$SRC/server/push.py" "$DROPLET:/opt/nhc-push/push.py.new" 2>/dev/null || { "${SSH[@]}" mkdir -p /opt/nhc-push; rsync -az -e "ssh -i $KEY -o BatchMode=yes" "$SRC/server/push.py" "$DROPLET:/opt/nhc-push/push.py.new"; }
sed "s#__HOST__#$HOST#g" "$SRC/server/nhc-push.service" | "${SSH[@]}" "cat > /opt/nhc-push/nhc-push.service.new"
"${SSH[@]}" bash -s <<'PUSH'
set -euo pipefail
cd /opt/nhc-push
changed=0
python3 -m py_compile push.py.new
for f in push.py nhc-push.service; do
  if ! cmp -s "$f.new" "$f" 2>/dev/null; then mv "$f.new" "$f"; changed=1; else rm -f "$f.new"; fi
done
if ! cmp -s nhc-push.service /etc/systemd/system/nhc-push.service 2>/dev/null; then cp nhc-push.service /etc/systemd/system/; systemctl daemon-reload; changed=1; fi
systemctl enable nhc-push.service >/dev/null 2>&1
if [ "$changed" = 1 ] || ! systemctl is-active --quiet nhc-push; then systemctl restart nhc-push; fi
sleep 1
systemctl is-active --quiet nhc-push && echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [droplet] INFO nhc-push active (changed=$changed)" || { journalctl -u nhc-push -n 20 --no-pager; exit 1; }
PUSH

# 2–3) вхост и сертификат
DNS_IP="$(dig +short "$HOST" @1.1.1.1 | tail -1 || true)"
log INFO "DNS $HOST → ${DNS_IP:-<нет записи>}"

"${SSH[@]}" HOST="$HOST" SLUG="$SLUG" CERTBOT_EMAIL="$CERTBOT_EMAIL" DNS_OK="$([ "$DNS_IP" = "$DROPLET_IP" ] && echo 1 || echo 0)" bash -s <<'REMOTE'
set -euo pipefail
CONF=/etc/nginx/sites-available/$SLUG.conf
CERT=/etc/letsencrypt/live/$HOST/fullchain.pem
log() { printf '%s [droplet] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2"; }
mkdir -p /var/www/acme

write_http() {
cat > "$CONF.new" <<EOF
# «Практика» — ставится deploy.sh из репозитория nhc_diary.
server {
    listen 80; listen [::]:80;
    server_name $HOST;
    access_log /var/log/nginx/$SLUG.access.log;
    location /.well-known/acme-challenge/ { root /var/www/acme; }
    location / { return 301 https://\$host\$request_uri; }
}
EOF
}
write_full() {
write_http
cat >> "$CONF.new" <<EOF

server {
    listen 443 ssl http2; listen [::]:443 ssl http2;
    server_name $HOST;
    ssl_certificate     /etc/letsencrypt/live/$HOST/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$HOST/privkey.pem;
    root /var/www/$SLUG;
    index index.html;
    access_log /var/log/nginx/$SLUG.access.log;
    include /etc/nginx/snippets/agent-team-headers.conf;
    add_header X-Robots-Tag "noindex, nofollow" always;
    add_header Cache-Control "no-cache" always;
    gzip on; gzip_types text/css application/javascript application/manifest+json;
    location ~ \.webmanifest\$ { types { } default_type application/manifest+json; }
    location /api/push/ {
        proxy_pass http://127.0.0.1:8790;
        proxy_set_header X-Real-IP \$remote_addr;
        client_max_body_size 8k;
        proxy_read_timeout 20s;
    }
    location / { try_files \$uri \$uri/ =404; }
}
EOF
}

if [ -f "$CERT" ]; then write_full; MODE=https; else write_http; MODE=http; fi
if ! cmp -s "$CONF.new" "$CONF" 2>/dev/null; then
  [ -f "$CONF" ] && cp "$CONF" "$CONF.bak"
  mv "$CONF.new" "$CONF"; ln -sf "$CONF" /etc/nginx/sites-enabled/$SLUG.conf
  if nginx -t 2>/dev/null; then systemctl reload nginx; log INFO "vhost $MODE installed"
  else log ERROR "nginx -t failed, rollback"; if [ -f "$CONF.bak" ]; then mv "$CONF.bak" "$CONF"; else rm -f "$CONF" /etc/nginx/sites-enabled/$SLUG.conf; fi; nginx -t; exit 1; fi
else rm -f "$CONF.new"; log INFO "vhost $MODE unchanged"; fi

if [ ! -f "$CERT" ]; then
  if [ "$DNS_OK" = 1 ]; then
    [ -z "${CERTBOT_EMAIL:-}" ] && [ -f /etc/agent-team/env ] && . /etc/agent-team/env
    [ -n "${CERTBOT_EMAIL:-}" ] || { log ERROR "задай CERTBOT_EMAIL в deploy.env"; exit 1; }
    certbot certonly --webroot -w /var/www/acme -d "$HOST" --non-interactive --agree-tos -m "$CERTBOT_EMAIL" --deploy-hook "systemctl reload nginx"
    log INFO "certificate issued"
    write_full; mv "$CONF.new" "$CONF"; nginx -t && systemctl reload nginx; log INFO "vhost https installed"
  else
    log WARNING "нет A-записи $HOST → droplet: сертификат не выпущен, сайт только по http-заглушке"
  fi
fi
REMOTE

if curl -fsS -o /dev/null -w '%{http_code}' "https://$HOST/" 2>/dev/null; then echo; log INFO "OK https://$HOST/"; else log WARNING "https://$HOST/ пока не отвечает"; fi
