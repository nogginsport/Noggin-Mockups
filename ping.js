// api/ping.js
//
// The simplest possible endpoint, deliberately. If this fails the same way
// generate.js does, the problem isn't in generate.js's logic at all — it's
// something about the Vercel project/deployment itself.

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({ ok: true, message: 'pong', timestamp: Date.now() });
};
