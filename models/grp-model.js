const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const GRP = sequelize.define('grp', {
    ri: {
        type: DataTypes.STRING(24),
        primaryKey: true,
        allowNull: false,
    },
    ty: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 9,
    },
    sid: DataTypes.STRING,
    int_cr: DataTypes.STRING,
    rn: DataTypes.STRING,
    pi: DataTypes.STRING,
    et: DataTypes.STRING(20),
    ct: DataTypes.STRING(20),
    lt: DataTypes.STRING(20),
    acpi: DataTypes.ARRAY(DataTypes.STRING),
    lbl: DataTypes.ARRAY(DataTypes.STRING),
    cr: DataTypes.STRING,
    mt: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
    },
    cnm: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
    },
    mnm: DataTypes.INTEGER,
    csy: {
        type: DataTypes.INTEGER,
        defaultValue: 1,
    },
    mid: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        defaultValue: [],
    },
    gn: DataTypes.STRING,
}, {
    tableName: 'grp',
    timestamps: false,
});

module.exports = GRP;