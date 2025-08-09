import swaggerJsdoc from 'swagger-jsdoc';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const root = path.resolve(__dirname, '..');

const options = {
  definition: {
    openapi: '3.0.4',
    info: {
      title: 'BARS Core API',
      version: '2.0.0',
      description: 'API documentation for BARS Core',
      contact: {
        name: 'BARS Support',
        email: 'support@stopbars.com',
        url: 'https://stopbars.com/support'
      }
    },
    externalDocs: {
      description: 'Find more info here',
      url: 'https://docs.stopbars.com'
    },
    servers: [
      { url: 'https://v2.stopbars.com', description: 'Production' },
      { url: 'http://localhost:8787', description: 'Local development (wrangler dev)' }
    ],
    tags: [
      { name: 'RealTime', description: 'WebSocket connection and real-time state interaction endpoints.' },
      { name: 'State', description: 'Endpoints for retrieving current system or airport lighting/network state.' },
      { name: 'Auth', description: 'Authentication, account management, and API key lifecycle.' },
      { name: 'Airports', description: 'Lookup and metadata endpoints for airports.' },
      { name: 'Divisions', description: 'Division management, membership, and associated airport access.' },
      { name: 'Points', description: 'Creation and management of lighting/navigation point data.' },
      { name: 'Support', description: 'Utilities for generating light support / BARS XML artifacts.' },
      { name: 'NOTAM', description: 'Global NOTAM retrieval and (staff) updates.' },
      { name: 'Contributions', description: 'Community lighting package submission, review, and leaderboard.' },
      { name: 'Staff', description: 'Restricted staff-only operational and moderation endpoints (hidden from public docs).' },
      { name: 'CDN', description: 'File storage, upload, listing, and deletion via CDN-backed storage.' },
      { name: 'EuroScope', description: 'EuroScope sector file upload, listing, and permission checks by ICAO.' },
      { name: 'Cache', description: 'Administrative cache management operations.' },
      { name: 'GitHub', description: 'Repository contributor information.' },
      { name: 'System', description: 'System health and OpenAPI specification discovery.' }
    ]
  },
  apis: [path.join(root, 'src', '**', '*.ts')]
};

const openapiSpec = swaggerJsdoc(options);
fs.writeFileSync(path.join(root, 'openapi.json'), JSON.stringify(openapiSpec, null, 2));
console.log('OpenAPI spec generated at openapi.json');
