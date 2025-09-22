const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const DTS = sequelize.define('dts', {
  ri: {
    type: DataTypes.STRING(24),
    primaryKey: true,
    allowNull: false,
  },
  ty: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 105,
  },
  sid: DataTypes.STRING,
  int_cr: DataTypes.STRING,
  rn: DataTypes.STRING,
  pi: DataTypes.STRING,
  et: DataTypes.STRING(20),
  ct: DataTypes.STRING(20),
  lt: DataTypes.STRING(20),
  acpi: {
    type: DataTypes.ARRAY(DataTypes.STRING),
    defaultValue: null,
  },
  lbl: {
    type: DataTypes.ARRAY(DataTypes.STRING),
    defaultValue: null,
  },
  cr: DataTypes.STRING,

  // resource specific attributes
  dspi: DataTypes.STRING(255), // datasetPolicyID (Read Only)
  lof: DataTypes.ARRAY(DataTypes.STRING), // listOfFeatures (Read Only)
  dsf_list: DataTypes.ARRAY(DataTypes.STRING), // list of dsf resources (Read Only)
}, {
  tableName: 'dts',
  timestamps: false,
});

module.exports = DTS;