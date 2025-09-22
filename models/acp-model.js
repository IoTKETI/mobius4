const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const ACP = sequelize.define('acp', {
  ri: { type: DataTypes.STRING(24), primaryKey: true },
  ty: { type: DataTypes.INTEGER, allowNull: false },
  sid: { type: DataTypes.STRING },
  int_cr: { type: DataTypes.STRING },
  rn: { type: DataTypes.STRING },
  pi: { type: DataTypes.STRING },
  et: { type: DataTypes.STRING },
  ct: { type: DataTypes.STRING },
  lt: { type: DataTypes.STRING },
  acpi: { type: DataTypes.ARRAY(DataTypes.STRING) },
  lbl: { type: DataTypes.ARRAY(DataTypes.STRING) },
  cr: { type: DataTypes.STRING },
  pv: { type: DataTypes.JSONB },
  pvs: { type: DataTypes.JSONB },
}, {
  tableName: 'acp',
  timestamps: false,
});

module.exports = ACP;