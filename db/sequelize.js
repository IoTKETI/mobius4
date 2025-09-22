const { Sequelize } = require('sequelize');
const config = require('config');

const sequelize = new Sequelize(
  config.get('db.name'),
  config.get('db.user'),
  config.get('db.pw'),
  {
    host: config.get('db.host'),
    port: config.get('db.port'),
    dialect: 'postgres',
    logging: false, // set this 'true' to see SQL logs
    dialectOptions: {
      // PostGIS extension is used for location data
      postgis: true
    }
  }
);

module.exports = sequelize;