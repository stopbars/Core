# Contributing to BARS Core

Thank you for your interest in contributing to BARS Core! This guide will help you get started with contributing.

## Getting Started

### Prerequisites

- Node.js 18 or higher
- Git
- Wrangler CLI: `npm install -g wrangler`
- Cloudflare account (for any testing with live services)

### Development Setup

1. **Fork and Clone**

   ```bash
   git clone https://github.com/stopbars/Core.git

   cd Core
   ```

   <br>

2. **Install Dependencies**

   ```bash
   npm install
   ```

   <br>

3. **Configure Development Environment**

   <br>

   **Set up Cloudflare configuration:**

   The `wrangler.toml` file is already configured and safe to use as-is. For local testing, you'll need to:
   1. Create your own D1 SQL database in the [Cloudflare Dashboard](https://dash.cloudflare.com) (Storage & Databases > D1 SQL)

   <br>
   2. Edit `wrangler.toml` and update the database configuration (see comments in the file):
      - `account_id`: Your Cloudflare account ID (found in dash.cloudflare.com/your-id/home)
      - `VATSIM_CLIENT_ID`: Your VATSIM Connect application client ID
      - `database_name`: Your D1 database name (e.g., "bars-dev")
      - `database_id`: Your D1 database ID (found in your database page)

   <br>
   3. Update `package.json` scripts to use your database name:
      - Replace `bars-db` with your database name in the `update-db-local` and `update-db` scripts
      - Example: `"update-db": "wrangler d1 execute bars-dev-example --remote --file schema.sql",`

   <br>

   > [!IMPORTANT]  
   > **Important**: Do not commit changes to `wrangler.toml` or `package.json` database configuration. These are for local development only and should remain as local modifications.

   <br>

   **Setup environment variables:**

   <br>

   ```bash
   copy .dev.vars.example .dev.vars
   ```

   <br>

   Edit `.dev.vars` and add your API credentials:
   - `VATSIM_CLIENT_SECRET`: Your VATSIM Connect application secret
   - `AIRPORTDB_API_KEY`: Your [AirportDB](https://airportdb.io/) API key (optional for basic testing)

   <br>

4. **Start Development Server**
   ```bash
   npm run dev
   ```

## Development Guidelines

### Code Style

- Use TypeScript for all new code
- Follow existing naming conventions
- Use [JSDoc comments](https://jsdoc.app/about-getting-started) for public methods
- Use meaningful variable and function names

### API Design

- Follow RESTful principles
- Use appropriate HTTP status codes
- Include proper CORS headers
- Validate all input data

### Database

- Use prepared statements for all queries
- Include proper indexes for performance
- Follow the existing schema patterns
- Test database migrations carefully

## Contribution Process

### 1. Find or Create an Issue

- Browse existing issues for bug fixes or feature requests
- Create a new issue for significant changes
- Discuss the approach before starting work

### 2. Create a Feature Branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/your-bug-fix
```

### 3. Make Your Changes

- Write clean, well-documented code
- Test your changes thoroughly
- Update documentation if necessary

### 4. Commit Your Changes

```bash
git add .
git commit -m "Add brief description of your changes"
```

Use clear, descriptive commit messages:

- `feat: add support for approach lighting`
- `fix: resolve stopbar state synchronization issue`
- `docs: update contribution documentation`

### 5. Push and Create Pull Request

```bash
git push origin feature/your-feature-name
```

Create a pull request with:

- Clear description of changes
- Reference to related issues
- Screenshots for UI changes (if applicable)

## Testing

### Manual Testing

1. Start the development server: `npm run dev`
2. Test API endpoints with curl or Postman
3. Verify database operations work correctly
4. Test real-time functionality with WebSocket clients

### Testing with VATSIM

For features requiring VATSIM authentication, you'll need:

- Valid VATSIM developer account (Sandbox account)
- Test OAuth application
- Test VATSIM credentials

## Common Issues

### Database Errors

- Ensure your D1 database is properly configured
- Check that all required tables exist
- Verify your SQL syntax is compatible with Cloudflare D1

### CORS Issues

- Always include proper CORS headers in responses
- Test with different origins during development

### TypeScript Errors

- Keep type definitions up to date
- Use proper interfaces for all data structures
- Run `npm run typegen` after schema changes

## Getting Help

- **Discord**: Join the BARS [Discord](https://stopbars.com/discord) server for real-time help
- **GitHub Issues**: [Create an issue](https://github.com/stopbars/Core/issues/new) for bugs or feature requests
- **Code Review**: Ask for reviews on complex changes

## Recognition

Contributors are recognized in:

- Release notes for significant contributions
- BARS website credits page (coming soon)

Thank you for helping make BARS better for the entire virtual aviation community!
