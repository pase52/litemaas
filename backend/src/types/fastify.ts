// Type declarations for Fastify config and extensions
declare module 'fastify' {
  interface FastifyInstance {
    config: {
      // Server
      NODE_ENV: string;
      HOST: string;
      PORT: string;
      LOG_LEVEL: string;
      OPENSHIFT_API_URL?: string;

      // CORS
      CORS_ORIGIN: string;

      // Database
      DATABASE_URL: string;
      DB_MAX_CONNECTIONS: string;
      DB_IDLE_TIMEOUT: string;
      DB_CONNECTION_TIMEOUT: string;

      // JWT
      JWT_SECRET: string;
      JWT_EXPIRES_IN: string;

      // OAuth / OIDC
      AUTH_PROVIDER: string;
      OAUTH_CLIENT_ID: string;
      OAUTH_CLIENT_SECRET: string;
      OAUTH_ISSUER: string;
      OAUTH_CALLBACK_URL: string;
      K8S_API_SKIP_TLS_VERIFY?: string;
      OIDC_GROUPS_CLAIM: string;
      OIDC_SCOPES?: string;
      OAUTH_SCOPES?: string;

      // Redis (optional)
      REDIS_HOST?: string;
      REDIS_PORT: string;
      REDIS_PASSWORD?: string;

      // LiteLLM
      LITELLM_API_URL: string;
      LITELLM_API_KEY?: string;
      LITELLM_MASTER_KEY?: string;
      LITELLM_TIMEOUT: string;
      LITELLM_RETRIES: string;
      LITELLM_RETRY_DELAY: string;

      // Secrets encryption
      ENCRYPTION_KEY?: string;

      // MaaS (RHOAI Models-as-a-Service)
      MAAS_ENABLED: string;
      MAAS_API_URL?: string;
      MAAS_GATEWAY_URL?: string;
      MAAS_NAMESPACE: string;
      MAAS_INSTANCE_ID?: string;
      MAAS_MODEL_NAMESPACES?: string;
      MAAS_SYNC_INTERVAL_MS: string;
      MAAS_RECONCILE_INTERVAL_MS: string;
      MAAS_MIGRATION_GRACE_DAYS: string;
      MAAS_USAGE_HITS_METRIC: string;
      MAAS_USAGE_CALLS_METRIC: string;
      MAAS_USAGE_LABEL_MATCHERS?: string;
      MAAS_USAGE_RETENTION_DAYS: string;
      K8S_API_URL?: string;
      K8S_TOKEN?: string;
      PROMETHEUS_URL?: string;
      PROMETHEUS_TOKEN?: string;
      PROMETHEUS_SKIP_TLS_VERIFY?: string;
      PROMETHEUS_TIMEOUT_MS: string;
      MAAS_API_SKIP_TLS_VERIFY?: string;

      // Usage Cache
      USAGE_CACHE_TTL_MINUTES: string;

      // Rate Limiting
      RATE_LIMIT_MAX: string;
      RATE_LIMIT_TIME_WINDOW: string;

      // Initial Admin Users
      INITIAL_ADMIN_USERS?: string;

      // Default User Values
      DEFAULT_USER_MAX_BUDGET: string;
      DEFAULT_USER_TPM_LIMIT: string;
      DEFAULT_USER_RPM_LIMIT: string;
    };

    // Remove custom logger interface to avoid conflict with Fastify's built-in logger

    // Database utilities - remove to avoid conflict with database plugin
    // dbUtils is provided by the database plugin

    // Error creation - remove to avoid conflict with error handler plugin
    // createError is provided by the error handler plugin

    // LiteLLM Service
    liteLLMService: import('../services/litellm.service').LiteLLMService;

    // Per-model backend registry (litellm / maas)
    backends: import('../services/backends/backend-registry').BackendRegistry;
    // MaaS clients (undefined unless MAAS_ENABLED=true)
    maasClients: import('../services/maas/maas-clients').MaasClients | undefined;
  }
}

// Export empty object to make this a module
export {};
