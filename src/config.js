import dotenv from 'dotenv';
import path from 'path';

// 加载环境变量
dotenv.config();

const config = {
  // 服务器配置
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || 'localhost',
    env: process.env.NODE_ENV || 'development'
  },

  // 数据库配置
  database: {
    path: process.env.DB_PATH || path.join(process.cwd(), 'data', 'state.json')
  },

  // 会话配置
  session: {
    ttlMs: parseInt(process.env.SESSION_TTL_MS || '43200000', 10), // 12小时
    secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-production'
  },

  // 安全配置
  security: {
    bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '12', 10),
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15分钟
    rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    loginRateLimitMax: parseInt(process.env.LOGIN_RATE_LIMIT_MAX || '5', 10),
    corsOrigins: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : ['http://localhost:3000']
  },

  // 日志配置
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    dir: process.env.LOG_DIR || 'logs'
  },

  // Excel 配置
  excel: {
    defaultPath: process.env.EXCEL_PATH || path.join(process.cwd(), '11月 ODCASA订单-追踪进度表.xlsx')
  },

  // 导出配置
  export: {
    maxRows: parseInt(process.env.EXPORT_MAX_ROWS || '10000', 10)
  }
};

export default config;
