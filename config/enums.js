const rsc_str = {
  OK: 2000,
  CREATED: 2001,
  UPDATED: 2004,
  DELETED: 2002,
  BAD_REQUEST: 4000,
  NOT_FOUND: 4004,
  OPERATION_NOT_ALLOWED: 4005,
  ORIGINATOR_HAS_NO_PRIVILEGE: 4103,
  CONFLICT: 4105,
  INVALID_CHILD_RESOURCE_TYPE: 4108,
  ORIGINATOR_HAS_ALREADY_REGISTERED : 4117,
  PURCHASE_LIMIT_EXEEDED: 4999,
  INTERNAL_SERVER_ERROR: 5000,
  NOT_IMPLEMENTED: 5001,
  ALREADY_EXISTS: 5106,
  TARGET_NOT_SUBSCRIBABLE: 5203,
  NOT_ACCEPTABLE: 5207,
};

const ty_str = {
  1: "acp",
  2: "ae",
  3: "cnt",
  4: "cin",
  5: "cb",
  9: "grp",
  16: "csr",
  23: "sub",
  24: "smd",
  28: "flx",
  34: "dac",
  // below are non-standard resource types that are not in the oneM2M standard yet
  101: "mrp", // <modelRepo>
  102: "mmd", // <mlModel>
  103: "mdp", // <modelDeployments>
  104: "dpm", // <deployment>
  105: "dsp", // <mlDatasetPolicy> 
  106: "dts", // <dataset> for AI/ML dataset with <datasetFragment>
  107: "dsf", // <datasetFragment>
};

module.exports.rsc_str = rsc_str;
module.exports.ty_str = ty_str;
