import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import config from './config.js';

// Helmet 安全头
export const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
});

// CORS 配置
export const corsMiddleware = cors({
  origin: config.security.corsOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token']
});

// 全局限速
export const globalRateLimit = rateLimit({
  windowMs: config.security.rateLimitWindowMs,
  max: config.security.rateLimitMax,
  message: { error: '请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false
});

// 登录限速
export const loginRateLimit = rateLimit({
  windowMs: config.security.rateLimitWindowMs,
  max: config.security.loginRateLimitMax,
  message: { error: '登录尝试次数过多，请15分钟后再试' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip + ':' + (req.body?.username || 'unknown');
  }
});

// 请求日志中间件
export function requestLogger(logger) {
  return (req, res, next) => {
    const start = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - start;
      const logData = {
        method: req.method,
        url: req.url,
        status: res.statusCode,
        duration: `${duration}ms`,
        ip: req.ip,
        userAgent: req.get('User-Agent')
      };

      if (res.statusCode >= 400) {
        logger.warn('请求失败', logData);
      } else {
        logger.info('请求完成', logData);
      }
    });

    next();
  };
}

// 错误处理中间件
export function errorHandler(logger) {
  return (err, req, res, next) => {
    logger.error('未处理的错误', {
      error: err.message,
      stack: err.stack,
      url: req.url,
      method: req.method
    });

    res.status(err.status || 500).json({
      error: process.env.NODE_ENV === 'production'
        ? '服务器内部错误'
        : err.message
    });
  };
}

// 输入消毒中间件
export function sanitizeInput(req, res, next) {
  // 简单的 XSS 防护
  const sanitize = (obj) => {
    if (typeof obj === 'string') {
      return obj
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
    }
    if (Array.isArray(obj)) {
      return obj.map(sanitize);
    }
    if (obj && typeof obj === 'object') {
      return Object.fromEntries(
        Object.entries(obj).map(([key, value]) => [key, sanitize(value)])
      );
    }
    return obj;
  };

  if (req.body) {
    req.body = sanitize(req.body);
  }
  if (req.query) {
    req.query = sanitize(req.query);
  }
  if (req.params) {
    req.params = sanitize(req.params);
  }

  next();
}
