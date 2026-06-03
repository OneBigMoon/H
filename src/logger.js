import winston from 'winston';
import path from 'path';

const { combine, timestamp, printf, colorize, errors } = winston.format;

// 自定义日志格式
const logFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  let msg = `${timestamp} [${level}]: ${message}`;
  if (stack) {
    msg += `\n${stack}`;
  }
  if (Object.keys(meta).length > 0) {
    msg += ` ${JSON.stringify(meta)}`;
  }
  return msg;
});

// 创建 logger 实例
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  transports: [
    // 控制台输出
    new winston.transports.Console({
      format: combine(
        colorize(),
        timestamp({ format: 'HH:mm:ss' }),
        logFormat
      )
    }),
    // 错误日志文件
    new winston.transports.File({
      filename: path.join('logs', 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    // 所有日志文件
    new winston.transports.File({
      filename: path.join('logs', 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ],
  // 未捕获异常处理
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join('logs', 'exceptions.log'),
      maxsize: 5242880,
      maxFiles: 3
    })
  ],
  // Promise rejection 处理
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join('logs', 'rejections.log'),
      maxsize: 5242880,
      maxFiles: 3
    })
  ]
});

// 创建 HTTP 请求日志流
export const httpLogStream = {
  write: (message) => {
    logger.info(message.trim());
  }
};

export default logger;
