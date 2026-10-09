// Set required env vars before any module that reads config is imported
process.env['NODE_ENV'] = 'test';
process.env['REDIS_URL'] = 'redis://localhost:6379';
process.env['OPENAI_API_KEY'] = 'test-api-key';
process.env['OPENAI_BASE_URL'] = 'https://api.openai.com/v1';
process.env['GITHUB_WEBHOOK_SECRET'] = 'github-test-secret';
process.env['GITHUB_ACCESS_TOKEN'] = 'test-gh-token';
process.env['GITLAB_WEBHOOK_SECRET'] = 'gitlab-test-secret';
process.env['GITLAB_ACCESS_TOKEN'] = 'test-gl-token';
process.env['ENABLE_REVIEW_BY_COMMENT'] = 'true';
process.env['ENABLE_REVIEW_BY_MR_OPEN'] = 'true';
process.env['ENABLE_FIX_BY_COMMENT'] = 'true';
process.env['WORKSPACE_DIR'] = '/tmp/ai-reviewer-test';
process.env['LOG_LEVEL'] = 'error';
