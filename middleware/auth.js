const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/**
 * Required Authentication Middleware
 * Extracts the Bearer JWT token from the Authorization header,
 * validates it with Supabase Auth, and attaches `req.user` (with `id`, `email`, etc.).
 */
const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Authorization token missing or malformed (expected Bearer <token>)',
      });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access token missing',
      });
    }

    // Verify token with Supabase GoTrue
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired authentication session',
        error: error?.message,
      });
    }

    // Attach user to request object
    req.user = user;
    req.userId = user.id;
    next();
  } catch (err) {
    console.error('[AUTH MIDDLEWARE ERROR]', err);
    return res.status(500).json({
      success: false,
      message: 'Authentication verification failure',
    });
  }
};

/**
 * Optional Authentication Middleware
 * Attaches user if a valid token is provided, but allows the request to continue if not.
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      if (token) {
        const { data: { user } } = await supabase.auth.getUser(token);
        if (user) {
          req.user = user;
          req.userId = user.id;
        }
      }
    }
    next();
  } catch (err) {
    // Non-blocking for optional auth
    next();
  }
};

module.exports = {
  requireAuth,
  optionalAuth,
};
