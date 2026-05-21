module.exports = {
  apps: [
    {
      name: "stempelo",
      script: "./server.js",
      interpreter: "/usr/local/node20/bin/node",
      env: {
        NODE_ENV: "production",
        PORT: 8055
      }
    }
  ]
};

