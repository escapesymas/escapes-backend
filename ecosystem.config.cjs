module.exports = {
  apps: [{
    name: 'escapes-backend',
    script: 'index.js',
    cwd: '/var/www/vhosts/backendescapes.com/server',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '2G',
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
      DATABASE_URL: 'postgresql://postgres:EscapesPostgres2026Vercel@localhost:5432/escapes_db',
      STRIPE_SECRET_KEY: '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',
      STRIPE_WEBHOOK_SECRET: 'whsec_bGl2ZV9uVENyTmZ1UFkzUWdOOWlhUjVTdGJtQXlPd2ZOSXRqYVozd2NsQ3BWQTVEQVhtM2gzclhxN0VFbjFQNnFhcg',
      WP_URL: 'https://backendescapes.com',
      BIHR_USERNAME: 'info@escapesymas.com',
      BIHR_MACKEY: '3799B392-3934-4514-ABF0-9EF7F544A117',
      BIHR_API_BASE: 'https://api.bihr.net',
      MINIMAX_API_KEY: 'sk-cp-IjvomnJ7PdDWM6F8zzGJtLIHiL-l3d-CnDAOwhoxpV3cRU7cFWB2qnAlOcIgpGmAcMezcyZhN-nF8Qq88N_6CCdkTw1M8j094Dlwapy7CEypGXnhXNmRVyk'
    }
  }]
};
