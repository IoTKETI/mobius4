const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const DSF = sequelize.define('dsf', {
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
  dfst: DataTypes.STRING(20), // datasetFragmentStartTime (Read Only)
  dfet: DataTypes.STRING(20), // datasetFragmentEndTime (Read Only)
  nrf: DataTypes.INTEGER, // numberOfRowsInFragment (Read Only)
  dsfr: DataTypes.JSONB, // datasetFragment (Read Only) - can store CSV string or JSON object
  dsfm: DataTypes.INTEGER, // datasetFormat (Read Only)
}, {
  tableName: 'dsf',
  timestamps: false,
});

module.exports = DSF;