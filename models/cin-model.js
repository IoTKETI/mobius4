const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const CIN = sequelize.define('cin', {
  ri: {
    type: DataTypes.STRING(24),
    primaryKey: true,
    allowNull: false,
  },
  ty: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 4,
  },
  rn: { type: DataTypes.STRING, allowNull: false },
  pi: DataTypes.STRING,
  sid: DataTypes.STRING,
  et: DataTypes.STRING(20),
  ct: DataTypes.STRING(20),
  lt: DataTypes.STRING(20),
  acpi: DataTypes.ARRAY(DataTypes.STRING),
  lbl: DataTypes.ARRAY(DataTypes.STRING),
  st: DataTypes.INTEGER,
  cr: DataTypes.STRING,
  cnf: DataTypes.STRING,
  cs: DataTypes.INTEGER,
  con: DataTypes.JSONB,
  loc: DataTypes.GEOMETRY('GEOMETRY', 4326),
}, {
  tableName: 'cin',
  timestamps: false,
});

module.exports = CIN;