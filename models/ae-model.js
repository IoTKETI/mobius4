const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const AE = sequelize.define('ae', {
  ri: { type: DataTypes.STRING(24), primaryKey: true },
  ty: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 2 },
  sid: { type: DataTypes.STRING },
  int_cr: { type: DataTypes.STRING },
  rn: { type: DataTypes.STRING, allowNull: false },
  pi: { type: DataTypes.STRING },
  et: { type: DataTypes.STRING(20) },
  ct: { type: DataTypes.STRING(20) },
  lt: { type: DataTypes.STRING(20) },
  acpi: { type: DataTypes.ARRAY(DataTypes.STRING) },
  lbl: { type: DataTypes.ARRAY(DataTypes.STRING) },
  cr: { type: DataTypes.STRING },
  api: { type: DataTypes.STRING },
  apn: { type: DataTypes.STRING },
  aei: { type: DataTypes.STRING },
  poa: { type: DataTypes.ARRAY(DataTypes.STRING) },
  rr: { type: DataTypes.BOOLEAN, allowNull: false },
  srv: { type: DataTypes.ARRAY(DataTypes.STRING) },
  csz: { type: DataTypes.ARRAY(DataTypes.STRING) },
  // 'or' (ontologyRef) is a reserved SQL keyword; Sequelize quotes every identifier, so the
  // column name is safe as written. Same treatment as models/flx-model.js.
  or: { type: DataTypes.STRING },
  loc: { type: DataTypes.GEOMETRY('GEOMETRY', 4326) },
}, {
  tableName: 'ae',
  timestamps: false,
});

module.exports = AE;