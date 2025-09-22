const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const SUB = sequelize.define('sub', {
  ri: { type: DataTypes.STRING(24), primaryKey: true },
  ty: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 23 },
  sid: { type: DataTypes.STRING },
  int_cr: { type: DataTypes.STRING },
  rn: { type: DataTypes.STRING },
  pi: { type: DataTypes.STRING },
  et: { type: DataTypes.STRING },
  ct: { type: DataTypes.STRING },
  lt: { type: DataTypes.STRING },
  acpi: { type: DataTypes.ARRAY(DataTypes.STRING) },
  lbl: { type: DataTypes.ARRAY(DataTypes.STRING) },
  enc: { type: DataTypes.JSONB },
  exc: { type: DataTypes.INTEGER },
  nu: { type: DataTypes.ARRAY(DataTypes.STRING) },
  nct: { type: DataTypes.INTEGER },
  cr: { type: DataTypes.STRING },
  su: { type: DataTypes.STRING },
}, {
  tableName: 'sub',
  timestamps: false,
});

module.exports = SUB;