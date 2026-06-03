// 自定义错误类
export class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

// 认证错误
export class AuthenticationError extends AppError {
  constructor(message = '未登录或会话已过期') {
    super(message, 401, 'AUTHENTICATION_ERROR');
  }
}

// 授权错误
export class AuthorizationError extends AppError {
  constructor(message = '没有权限执行此操作') {
    super(message, 403, 'AUTHORIZATION_ERROR');
  }
}

// 资源未找到错误
export class NotFoundError extends AppError {
  constructor(message = '资源不存在') {
    super(message, 404, 'NOT_FOUND');
  }
}

// 验证错误
export class ValidationError extends AppError {
  constructor(message = '输入数据无效', details = []) {
    super(message, 400, 'VALIDATION_ERROR');
    this.details = details;
  }
}

// 冲突错误
export class ConflictError extends AppError {
  constructor(message = '资源冲突') {
    super(message, 409, 'CONFLICT');
  }
}

// 限流错误
export class RateLimitError extends AppError {
  constructor(message = '请求过于频繁') {
    super(message, 429, 'RATE_LIMIT_EXCEEDED');
  }
}

// 错误响应格式化
export function formatErrorResponse(err) {
  const response = {
    error: err.message,
    code: err.code || 'INTERNAL_ERROR'
  };

  if (err.details) {
    response.details = err.details;
  }

  if (process.env.NODE_ENV !== 'production' && err.stack) {
    response.stack = err.stack;
  }

  return response;
}

// 全局错误处理中间件
export function createErrorHandler(logger) {
  return (err, req, res, next) => {
    // 确定状态码
    const statusCode = err.statusCode || 500;

    // 记录日志
    if (statusCode >= 500) {
      logger.error('服务器错误', {
        error: err.message,
        stack: err.stack,
        url: req.url,
        method: req.method,
        ip: req.ip,
        userId: req.currentUser?.id
      });
    } else if (statusCode >= 400) {
      logger.warn('客户端错误', {
        error: err.message,
        code: err.code,
        url: req.url,
        method: req.method,
        ip: req.ip
      });
    }

    // 发送响应
    res.status(statusCode).json(formatErrorResponse(err));
  };
}

// 未捕获异常处理
export function setupUncaughtHandlers(logger) {
  process.on('uncaughtException', (err) => {
    logger.error('未捕获的异常', {
      error: err.message,
      stack: err.stack
    });
    // 给进程一点时间记录日志，然后退出
    setTimeout(() => {
      process.exit(1);
    }, 1000);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('未处理的 Promise 拒绝', {
      reason: reason?.message || reason,
      stack: reason?.stack
    });
  });
}
