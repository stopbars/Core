import swaggerJsdoc from 'swagger-jsdoc';
import fs from 'fs';

const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'BARS Core API',
            version: '1.0.0',
            description: 'API documentation for BARS Core',
        },
    },
    apis: ['./src/**/*.ts'],
};

const openapiSpec = swaggerJsdoc(options);
fs.writeFileSync('./openapi.json', JSON.stringify(openapiSpec, null, 2));
console.log('OpenAPI spec generated at openapi.json');