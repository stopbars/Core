import swaggerJsdoc from 'swagger-jsdoc';
import fs from 'fs';

// This script generates the OpenAPI spec by scanning JSDoc comments in the src directory.
// Component schemas & security schemes are declared in src/openapi-components.ts via @openapi block.

const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'BARS Core API',
            version: '1.0.0',
            description: 'API documentation for BARS Core'
        },
        servers: [
            {
                url: 'https://v2.stopbars.com',
                description: 'Production'
            },
            {
                url: 'http://localhost:8787',
                description: 'Local development (wrangler dev)'
            }
        ]
    },
    apis: ['./src/**/*.ts']
};

const openapiSpec = swaggerJsdoc(options);
fs.writeFileSync('./openapi.json', JSON.stringify(openapiSpec, null, 2));
console.log('OpenAPI spec generated at openapi.json');