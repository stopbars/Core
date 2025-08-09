import swaggerJsdoc from 'swagger-jsdoc';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const root = path.resolve(__dirname, '..');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'BARS Core API',
      version: '2.0.0',
      description: 'API documentation for BARS Core'
    },
    servers: [
      { url: 'https://v2.stopbars.com', description: 'Production' },
      { url: 'http://localhost:8787', description: 'Local development (wrangler dev)' }
    ]
  },
  apis: [path.join(root, 'src', '**', '*.ts')]
};

const openapiSpec = swaggerJsdoc(options);
fs.writeFileSync(path.join(root, 'openapi.json'), JSON.stringify(openapiSpec, null, 2));
console.log('OpenAPI spec generated at openapi.json');
