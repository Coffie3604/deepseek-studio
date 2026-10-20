'use strict';
const { splice } = require('./_patch-helper');

splice(
    'server.js',
    'app.use(cors({',
    'app.use(express.json({ limit:',
`const BIND_ALL = HOST === '0.0.0.0' || HOST === '::';
app.use(cors({
    origin: (origin, cb) => {
        // Origin sharing is only ever granted to loopback (plus DS_ALLOWED_HOSTS).
        if (!origin) return cb(null, true); // non-browser client (curl, tests)
        return cb(null, isAllowedOrigin(origin, null));
    },
    credentials: false,
}));
/* Host-header guard (DNS-rebinding protection).
   A malicious page can point evil.example at 127.0.0.1; the browser then
   sends "Host: evil.example" and treats our responses as same-origin.
   Reject any Host that is not loopback / explicitly allow-listed. */
app.use((req, res, next) => {
    if (!isAllowedHost(req.headers.host, { bindAll: BIND_ALL })) {
        return res.status(421).json({ error: 'Misdirected request: host not allowed' });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});
`,
    'cors+host-guard',
);
