const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');
const enums = require('../config/enums');

const TSI = sequelize.define('tsi', {
  ri: {
    type: DataTypes.STRING(24),
    primaryKey: true,
    allowNull: false,
  },
  ty: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: enums.ty_num.tsi,
  },
  rn: { type: DataTypes.STRING, allowNull: false },
  pi: DataTypes.STRING,
  sid: DataTypes.STRING,
  int_cr: DataTypes.STRING,
  et: DataTypes.STRING(20),
  ct: DataTypes.STRING(20),
  lt: DataTypes.STRING(20),
  acpi: DataTypes.ARRAY(DataTypes.STRING),
  lbl: DataTypes.ARRAY(DataTypes.STRING),
  st: DataTypes.INTEGER,
  cr: DataTypes.STRING,
  dgt: { type: DataTypes.STRING(20), allowNull: false },
  cs: DataTypes.INTEGER,
  con: DataTypes.JSONB,
  snr: DataTypes.INTEGER,
  loc: DataTypes.GEOMETRY('GEOMETRY', 4326),
}, {
  tableName: 'tsi',
  timestamps: false,
});

module.exports = TSI;
