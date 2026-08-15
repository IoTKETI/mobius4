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
  NO_MEMBERS: 4109,
  SPECIALIZATION_SCHEMA_NOT_FOUND: 4125,
  GROUP_MEMBER_TYPE_INCONSISTENT: 4110,
  ORIGINATOR_HAS_ALREADY_REGISTERED : 4117,
  PURCHASE_LIMIT_EXEEDED: 4999,
  INTERNAL_SERVER_ERROR: 5000,
  NOT_IMPLEMENTED: 5001,
  TARGET_NOT_REACHABLE: 5103,
  RECEIVER_HAS_NO_PRIVILEGE: 5105,
  ALREADY_EXISTS: 5106,
  TARGET_NOT_SUBSCRIBABLE: 5203,
  NOT_ACCEPTABLE: 5207,
  MAX_NUMBER_OF_MEMBER_EXCEEDED: 6010
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

// Reverse of ty_str -- the resource type number for a given short name. BACKLOG-096: without
// this, each model file re-typed its own `ty` column defaultValue as a literal number, and three
// of them (mmd, dts, dsf) disagreed with the table above (107, 105, 105 instead of 102, 106,
// 107). Code that needs a ty number for a short name (model column defaults, primarily) should
// derive it from here rather than retype the literal, so the two tables cannot drift again.
const ty_num = Object.fromEntries(Object.entries(ty_str).map(([num, str]) => [str, Number(num)]));

module.exports.rsc_str = rsc_str;
module.exports.ty_str = ty_str;
module.exports.ty_num = ty_num;
