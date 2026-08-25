const { verifyToken } = require('../utils/jwt');

/**
 * Protects HTTP routes. Expects: Authorization: Bearer <token>
 */
function protect(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Not authorized. Missing or malformed Authorization header.',
      });
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Not authorized. No token provided.',
      });
    }

    const decoded = verifyToken(token);
    req.user = decoded; // { id, email, ... }
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, error: 'Token has expired.' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ success: false, error: 'Invalid token.' });
    }
    return res.status(401).json({ success: false, error: 'Not authorized.' });
  }
}

module.exports = { protect };
