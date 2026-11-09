#!/usr/bin/env python3
"""Пуш-сервис «Практики»: шлёт Web Push в заданное время (вибро на заблокированном экране iPhone).

API (за nginx, /api/push/):
  GET  /api/push/key                      → {"key": <VAPID public key, base64url>}
  POST /api/push/schedule {endpoint, jobs} → заменяет все ожидающие пуши этого устройства; jobs=[{at: ms, tag}]
  POST /api/push/last {endpoint}          → {"tag": последний отправленный тег} (сервис-воркер узнаёт текст)

Пуш без содержимого (не нужно шифрование payload), подпись VAPID (ES256) через cryptography.
Состояние — JSON-файл с атомарной записью (чекпоинт после каждого изменения), переживает рестарт.
Только стандартная библиотека + cryptography (на дроплете стоит вместе с certbot).
"""
import base64, json, logging, os, signal, sys, threading, time, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

# ===== параметры (переопределяются переменными окружения) =====
HOST = os.environ.get('PUSH_HOST', '127.0.0.1')
PORT = int(os.environ.get('PUSH_PORT', '8790'))
DATA_DIR = os.environ.get('PUSH_DATA_DIR', os.environ.get('STATE_DIRECTORY', '/var/lib/nhc-push'))
SUBJECT = os.environ.get('PUSH_SUBJECT', 'https://example.com')  # адрес сайта; Apple требует mailto: или https:
ALLOWED_PUSH_HOSTS = tuple(os.environ.get('PUSH_ALLOWED_HOSTS', 'push.apple.com,fcm.googleapis.com,push.services.mozilla.com,notify.windows.com').split(','))
ALLOWED_TAGS = {'walk_end', 'end', 'test'}
MAX_JOBS = 4                 # на устройство
MAX_AHEAD_SEC = 4 * 3600     # не дальше 4 ч вперёд
MAX_ENDPOINTS = 100
MAX_BODY = 4096
RATE_PER_MIN = 60            # запросов в минуту с одного IP
PUSH_TTL = 120               # сек: опоздавший больше чем на 2 мин пуш не нужен
TICK_SEC = 1.0
LOG_LEVEL = os.environ.get('PUSH_LOG_LEVEL', 'INFO')

logging.basicConfig(level=LOG_LEVEL, format='%(asctime)s %(levelname)s %(message)s', stream=sys.stdout)
log = logging.getLogger('nhc-push')

KEY_FILE = os.path.join(DATA_DIR, 'vapid_private.pem')
STATE_FILE = os.path.join(DATA_DIR, 'state.json')
lock = threading.Lock()
state = {'endpoints': {}}      # endpoint → {jobs: [{at, tag}], last_tag, last_at, updated}
rate = {}                      # ip → [minute, count]
stop = threading.Event()


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def short(endpoint: str) -> str:
    return urlparse(endpoint).hostname + '…' + endpoint[-8:]


# ===== VAPID =====
def load_key():
    os.makedirs(DATA_DIR, exist_ok=True)
    if os.path.exists(KEY_FILE):
        with open(KEY_FILE, 'rb') as f:
            key = serialization.load_pem_private_key(f.read(), password=None)
        log.info('VAPID key loaded')
    else:
        key = ec.generate_private_key(ec.SECP256R1())
        tmp = KEY_FILE + '.tmp'
        with open(tmp, 'wb') as f:
            f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        os.chmod(tmp, 0o600)
        os.replace(tmp, KEY_FILE)
        log.info('VAPID key generated')
    pub = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return key, b64u(pub)


PRIV, PUB = None, None


def vapid_jwt(aud: str) -> str:
    header = b64u(json.dumps({'typ': 'JWT', 'alg': 'ES256'}).encode())
    claims = b64u(json.dumps({'aud': aud, 'exp': int(time.time()) + 12 * 3600, 'sub': SUBJECT}).encode())
    msg = f'{header}.{claims}'.encode()
    r, s = decode_dss_signature(PRIV.sign(msg, ec.ECDSA(hashes.SHA256())))
    return f'{header}.{claims}.{b64u(r.to_bytes(32, "big") + s.to_bytes(32, "big"))}'


def send_push(endpoint: str) -> int:
    u = urlparse(endpoint)
    req = urllib.request.Request(endpoint, data=b'', method='POST', headers={
        'Authorization': f'vapid t={vapid_jwt(f"{u.scheme}://{u.netloc}")}, k={PUB}',
        'TTL': str(PUSH_TTL), 'Urgency': 'high', 'Content-Length': '0',
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status
    except urllib.error.HTTPError as e:
        log.warning('push HTTP %s for %s: %s', e.code, short(endpoint), e.read()[:200])
        return e.code
    except Exception as e:  # сеть, таймаут
        log.warning('push failed for %s: %s', short(endpoint), e)
        return 0


# ===== состояние (чекпоинт) =====
def load_state():
    global state
    try:
        with open(STATE_FILE) as f:
            state = json.load(f)
        log.info('state loaded: %d endpoints, %d jobs', len(state['endpoints']), sum(len(v['jobs']) for v in state['endpoints'].values()))
    except FileNotFoundError:
        log.info('fresh state')
    except Exception as e:
        log.error('state load failed (%s), starting fresh', e)


def save_state():
    tmp = STATE_FILE + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)


# ===== планировщик =====
def scheduler():
    log.info('scheduler started')
    while not stop.is_set():
        now = time.time() * 1000
        due = []
        with lock:
            for ep, rec in state['endpoints'].items():
                for j in [j for j in rec['jobs'] if j['at'] <= now]:
                    due.append((ep, j))
                    rec['jobs'].remove(j)
                    rec['last_tag'], rec['last_at'] = j['tag'], now   # до отправки: сервис-воркер спросит тег сразу
            if due:
                save_state()
        for ep, j in due:
            late = (now - j['at']) / 1000
            code = send_push(ep)
            log.info('push sent tag=%s to %s status=%s late=%.1fs', j['tag'], short(ep), code, late)
            if code in (404, 410):
                with lock:
                    state['endpoints'].pop(ep, None)
                    save_state()
                log.info('endpoint gone, removed %s', short(ep))
        stop.wait(TICK_SEC)
    log.info('scheduler stopped')


# ===== HTTP =====
def valid_endpoint(ep) -> bool:
    if not isinstance(ep, str) or len(ep) > 1024:
        return False
    u = urlparse(ep)
    return u.scheme == 'https' and bool(u.hostname) and any(u.hostname == h or u.hostname.endswith('.' + h) for h in ALLOWED_PUSH_HOSTS)


class Handler(BaseHTTPRequestHandler):
    server_version = 'nhc-push'

    def log_message(self, fmt, *args):
        log.debug('http %s %s', self.client_ip(), fmt % args)

    def client_ip(self):
        return self.headers.get('X-Real-IP') or self.client_address[0]

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def limited(self) -> bool:
        ip, minute = self.client_ip(), int(time.time() // 60)
        m, n = rate.get(ip, (minute, 0))
        n = n + 1 if m == minute else 1
        rate[ip] = (minute, n)
        if len(rate) > 5000:
            rate.clear()
        if n > RATE_PER_MIN:
            log.warning('rate limit %s', ip)
            self.reply(429, {'error': 'too many requests'})
            return True
        return False

    def read_json(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > MAX_BODY:
            raise ValueError('bad body size')
        return json.loads(self.rfile.read(n))

    def do_GET(self):
        if self.limited():
            return
        if self.path == '/api/push/key':
            return self.reply(200, {'key': PUB})
        self.reply(404, {'error': 'not found'})

    def do_POST(self):
        if self.limited():
            return
        try:
            data = self.read_json()
        except Exception as e:
            return self.reply(400, {'error': f'bad json: {e}'})
        ep = data.get('endpoint')
        if not valid_endpoint(ep):
            log.warning('rejected endpoint from %s', self.client_ip())
            return self.reply(400, {'error': 'bad endpoint'})
        if self.path == '/api/push/schedule':
            return self.schedule(ep, data.get('jobs'))
        if self.path == '/api/push/last':
            with lock:
                rec = state['endpoints'].get(ep) or {}
            return self.reply(200, {'tag': rec.get('last_tag'), 'at': rec.get('last_at')})
        self.reply(404, {'error': 'not found'})

    def schedule(self, ep, jobs):
        now = time.time() * 1000
        if not isinstance(jobs, list) or len(jobs) > MAX_JOBS:
            return self.reply(400, {'error': f'jobs: list of ≤{MAX_JOBS}'})
        clean = []
        for j in jobs:
            try:
                at, tag = float(j['at']), j['tag']
            except Exception:
                return self.reply(400, {'error': 'job: {at, tag}'})
            if tag not in ALLOWED_TAGS or not (now - 60e3 <= at <= now + MAX_AHEAD_SEC * 1000):
                return self.reply(400, {'error': 'job out of range'})
            clean.append({'at': at, 'tag': tag})
        with lock:
            eps = state['endpoints']
            if ep not in eps and len(eps) >= MAX_ENDPOINTS:
                idle = sorted((v['updated'], k) for k, v in eps.items() if not v['jobs'])
                if not idle:
                    return self.reply(503, {'error': 'full'})
                eps.pop(idle[0][1])
            rec = eps.setdefault(ep, {'jobs': [], 'last_tag': None, 'last_at': None, 'updated': now})
            rec['jobs'], rec['updated'] = clean, now
            save_state()
        log.info('schedule %s: %s', short(ep), [(j['tag'], round((j['at'] - now) / 1000)) for j in clean])
        self.reply(200, {'ok': True, 'jobs': len(clean)})


def main():
    global PRIV, PUB
    PRIV, PUB = load_key()
    load_state()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    t = threading.Thread(target=scheduler, daemon=True)
    t.start()

    def shutdown(sig, _):
        log.info('signal %s: saving state and stopping', sig)
        stop.set()
        with lock:
            save_state()
        threading.Thread(target=srv.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    log.info('listening on %s:%d, data %s', HOST, PORT, DATA_DIR)
    srv.serve_forever()
    t.join(timeout=3)
    log.info('stopped')


if __name__ == '__main__':
    main()
