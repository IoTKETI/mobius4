const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const CSR = sequelize.define('csr', {
  ri: { type: DataTypes.STRING(24), primaryKey: true, allowNull: false },
  acpi: DataTypes.ARRAY(DataTypes.STRING),
  cb: DataTypes.STRING,
  cr: DataTypes.STRING,
  csi: DataTypes.STRING,
  cst: DataTypes.INTEGER,
  csz: DataTypes.ARRAY(DataTypes.STRING),
  ct: DataTypes.STRING(20),
  et: DataTypes.STRING(20),
  int_cr: DataTypes.STRING,
  lbl: DataTypes.ARRAY(DataTypes.STRING),
  loc: DataTypes.GEOMETRY('GEOMETRY', 4326),
  lt: DataTypes.STRING(20),
  nl: DataTypes.STRING,
  pi: DataTypes.STRING,
  poa: DataTypes.ARRAY(DataTypes.STRING),
  rn: { type: DataTypes.STRING, allowNull: false },
  rr: { type: DataTypes.BOOLEAN, allowNull: false },
  sid: DataTypes.STRING,
  srv: DataTypes.ARRAY(DataTypes.STRING),
  csz: { type: DataTypes.ARRAY(DataTypes.STRING) },
  ty: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 16 },
}, {
  tableName: 'csr',
  timestamps: false,
});

module.exports = CSR;