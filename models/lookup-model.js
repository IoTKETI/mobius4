const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const Lookup = sequelize.define('lookup', {
  ri: { type: DataTypes.STRING(24), primaryKey: true },
  ty: { type: DataTypes.INTEGER, allowNull: false },
  rn: { type: DataTypes.STRING, allowNull: false },
  sid: { type: DataTypes.STRING, allowNull: false },
  lvl: { type: DataTypes.INTEGER, allowNull: false },
  pi: { type: DataTypes.STRING },
  cr: { type: DataTypes.STRING },
  int_cr: { type: DataTypes.STRING },
  et: { type: DataTypes.STRING(14), allowNull: true }, // expirationTime in "YYYYMMDDTHHmmss" format
  loc: { type: DataTypes.GEOMETRY('GEOMETRY', 4326) }, // PostGIS geometry
}, {
  tableName: 'lookup',
  timestamps: false,
});

module.exports = Lookup;