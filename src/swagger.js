import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'ODCASA 工单追踪系统 API',
      version: '1.1.0',
      description: 'ODCASA 内部工单/订单追踪系统的 API 文档',
      contact: {
        name: 'ODCASA 开发团队',
        email: 'dev@odcasa.com'
      },
      license: {
        name: 'Private',
        url: 'https://odcasa.com'
      }
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: '开发服务器'
      }
    ],
    components: {
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'sid',
          description: '会话 Cookie 认证'
        }
      },
      schemas: {
        User: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '用户ID' },
            username: { type: 'string', description: '用户名' },
            name: { type: 'string', description: '姓名' },
            role: { type: 'string', enum: ['admin', 'employee'], description: '角色' }
          }
        },
        Order: {
          type: 'object',
          properties: {
            id: { type: 'integer', description: '订单ID' },
            serial: { type: 'string', description: '订单号' },
            customer: { type: 'string', description: '客户' },
            product: { type: 'string', description: '产品' },
            spec: { type: 'string', description: '规格' },
            orderDate: { type: 'string', format: 'date', description: '下单日期' },
            dueDate: { type: 'string', format: 'date', description: '交期' },
            quantity: { type: 'string', description: '数量' },
            cycleDays: { type: 'string', description: '周期天数' },
            note: { type: 'string', description: '备注' },
            stages: {
              type: 'object',
              properties: {
                material: { type: 'string', description: '客供配件' },
                drawing: { type: 'string', description: '排单/图纸' },
                fabric: { type: 'string', description: '面料' },
                frame: { type: 'string', description: '木架' },
                padding: { type: 'string', description: '贴棉' }
              }
            },
            overall: { type: 'string', description: '整体状态' },
            assignedTo: { type: 'string', description: '负责人ID' },
            createdAt: { type: 'string', format: 'date-time', description: '创建时间' }
          }
        },
        Log: {
          type: 'object',
          properties: {
            id: { type: 'integer', description: '日志ID' },
            orderId: { type: 'integer', description: '订单ID' },
            userId: { type: 'string', description: '操作人ID' },
            action: { type: 'string', description: '操作类型' },
            stage: { type: 'string', description: '阶段' },
            before: { type: 'string', description: '变更前' },
            after: { type: 'string', description: '变更后' },
            comment: { type: 'string', description: '备注' },
            at: { type: 'string', format: 'date-time', description: '操作时间' }
          }
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string', description: '错误信息' },
            code: { type: 'string', description: '错误代码' }
          }
        },
        Pagination: {
          type: 'object',
          properties: {
            page: { type: 'integer', description: '当前页' },
            limit: { type: 'integer', description: '每页数量' },
            total: { type: 'integer', description: '总数' },
            totalPages: { type: 'integer', description: '总页数' }
          }
        }
      }
    },
    security: [{ cookieAuth: [] }]
  },
  apis: ['./server.js', './src/routes/*.js']
};

const swaggerSpec = swaggerJsdoc(options);

export function setupSwagger(app) {
  // Swagger UI
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'ODCASA API 文档'
  }));

  // OpenAPI JSON
  app.get('/api-docs.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });
}

export default swaggerSpec;
