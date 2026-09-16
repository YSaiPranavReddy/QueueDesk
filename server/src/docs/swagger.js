import swaggerJsdoc from 'swagger-jsdoc';
import config from '../config/index.js';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'QueueDesk API',
      version: '1.0.0',
      description: 'Enterprise-grade Real-Time Customer Support API',
      contact: {
        name: 'QueueDesk Support',
      },
    },
    servers: [
      {
        url: config.isProd ? 'https://queuedesk-cfm7.onrender.com' : `http://localhost:${config.port}`,
        description: config.isProd ? 'Production Server' : 'Local Development Server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Enter your access token here. For endpoints requiring authentication.',
        },
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'refreshToken',
          description: 'Refresh token cookie (automatically handled by browsers).',
        }
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
  },
  // Look for JSDoc comments in these files
  apis: ['./src/routes/*.js'],
};

export const swaggerSpec = swaggerJsdoc(options);
