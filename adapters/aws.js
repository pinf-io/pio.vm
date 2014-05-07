
const ASSERT = require("assert");
const CRYPTO = require("crypto");
const Q = require("q");
const AWS = require("aws-sdk");
const DEEPMERGE = require("deepmerge");
const REQUEST = require("request");
const WAITFOR = require("waitfor");


var adapter = exports.adapter = function(settings) {

	var self = this;

	self._settings = settings;

	ASSERT.equal(typeof self._settings.accessKeyId, "string");
	ASSERT.equal(typeof self._settings.secretAccessKey, "string");
	ASSERT.equal(typeof self._settings.region, "string");

    var awsConfig = new AWS.Config({
		accessKeyId: self._settings.accessKeyId,
		secretAccessKey: self._settings.secretAccessKey,
        region: self._settings.region
    });

	self._api = {
		ec2: new AWS.EC2(awsConfig)
	};

	self._keyId = null;
	self._securityGroupId = null;
}

adapter.prototype.ensure = function(vm) {
	var self = this;

	ASSERT.equal(typeof vm.name, "string");
	ASSERT.equal(typeof vm.ImageId, "string");
	ASSERT.equal(typeof vm.InstanceType, "string");
	ASSERT.equal(typeof vm.keyId, "string");
	ASSERT.equal(typeof vm.keyPub, "string");
	ASSERT.equal(typeof vm.securityGroup, "object");
	ASSERT.equal(typeof vm.securityGroup.name, "string");
	ASSERT.equal(typeof vm.securityGroup.incoming, "object");
	ASSERT.equal(Array.isArray(vm.BlockDeviceMappings), true);

	return self._getByName(vm.name).then(function(vmInfo) {
		if (vmInfo) {
			return vmInfo;
		}
		return self._create(vm).then(function(vmInfo) {
			return vmInfo;
		});
	});
}

adapter.prototype._getByName = function(name) {
	var self = this;
	return Q.denodeify(function (callback) {
		return self._api.ec2.describeInstances({
			Filters: [
				{
					Name: "tag-value",
					Values: [
						name
					]
				}
			]
		}, function (err, response) {
			if (err) return callback(err);
			if (!response.Reservations || response.Reservations.length === 0) {
				return callback(null);
			}
			response.Reservations = response.Reservations.filter(function(reservation) {
				return (reservation.Instances.filter(function(instance) {
					return (
						instance.State.Name !== "terminated" &&
						instance.State.Name !== "shutting-down")
				}).length !== 0);
			});
			if (response.Reservations.length === 0) {
				return callback(null);
			}
			function formatInfo(instance) {
				return {
					_raw: instance,
					ip: instance.PublicIpAddress || "",
					ipPrivate: instance.PrivateIpAddress || ""					
				};
			}
			if (response.Reservations[0].Instances[0].State.Name === "running") {
				return callback(null, formatInfo(response.Reservations[0].Instances[0]));
			}
			var instanceId = response.Reservations[0].Instances[0].InstanceId;
			function waitUntilReady(callback) {
				return self._api.ec2.describeInstances({
					InstanceIds: [
						instanceId
					]
				}, function (err, response) {
					if (err) return callback(err);
					if (
						response.Reservations.length !== 1 ||
						response.Reservations[0].Instances.length !== 1
					) {
						return callback(new Error("Unexpected status response: " + JSON.stringify(response)));
					}
					if (response.Reservations[0].Instances[0].State.Name === "running") {
						return callback(null, formatInfo(response.Reservations[0].Instances[0]));
					}
					console.log("Waiting for vm to boot ...");
					return setTimeout(function() {
						return waitUntilReady(callback);
					}, 5 * 1000);
				});
			}
			return waitUntilReady(callback);
		});
	})();
}

adapter.prototype._ensureSecurityGroup = function(vm) {
	var self = this;
	var groupName = vm.securityGroup.name;
	function getClientPublicIP(callback) {
	    return REQUEST({
	    	url: "https://freegeoip.net/json/",
	    	json: true,
	    	strictSSL: false
	    }, function(err, res, data) {
	        if (err) return callback(err);
	        console.log("Your public IP: " + data.ip);
	        return callback(null, data.ip);
		});
	}
	return Q.denodeify(getClientPublicIP)().then(function(clientPublicIP) {
		function _condenseRecords(records) {
			return records.map(function(record) {
				record.IpRanges.sort();
				return (record.IpProtocol + ":" + record.FromPort + ":" + record.ToPort + ":" + record.IpRanges.map(function(range) {
					return range.CidrIp;
				}).join(":"));
			});
		}
		function ensureGroupRecord(callback) {
			return self._api.ec2.describeSecurityGroups({
				GroupNames: [
					groupName
				]
			}, function (err, data) {
				function createDefaultRecords(records, callback) {
					var existing = _condenseRecords(records);
					var waitfor = WAITFOR.parallel(function(err) {
						if (err) return callback(err);
						return callback(null, records);
					});
					// TODO: Move this into `pio.firewall`.
					for (var port in vm.securityGroup.incoming) {
						if (vm.securityGroup.incoming[port]) {
							waitfor(port, function(port, done) {

								var ips = vm.securityGroup.incoming[port];

								if (existing.indexOf("tcp:" + port + ":" + port + ":" + ips) === -1) {
									console.log(("Adding unrestricted access to port " + port + " to security group '" + groupName + "' on AWS.").magenta);
							        return self._api.ec2.authorizeSecurityGroupIngress({
							            GroupName: groupName,
							            IpPermissions: [
							                {
							                    UserIdGroupPairs: [],
							                    IpRanges: [ { CidrIp: ips } ],
							                    IpProtocol: "tcp",
							                    FromPort: port,
							                    ToPort: port
							                }
							            ]
							        }, function(err, response) {
							            if (err) return callback(err);
							            return callback(null, records);
							        });
								} else {
									console.log("Verified unrestricted access to port " + port + " is configured in security group '" + groupName + "' on AWS.");
									return done();
								}
							});
						}
					}
					return waitfor;
				}
				function create(callback) {
					console.log(("Creating security group '" + groupName + "' on AWS.").magenta);
					return self._api.ec2.createSecurityGroup({
						GroupName: groupName,
						Description: groupName
					}, function(err, data) {
						if (err) return callback(err);
						self._securityGroupId = groupName;
						return createDefaultRecords([], callback);
					});
				}
				if (err) {
					if (/^InvalidGroup\.NotFound:/.test(err.toString())) {
						return create(callback);
					}
					return callback(err);
				} else
				if (data.SecurityGroups && data.SecurityGroups.length === 1 && data.SecurityGroups[0].GroupName === groupName) {
					self._securityGroupId = groupName;
					console.log("Verified that security group '" + groupName + "' is configured on AWS.");
					return createDefaultRecords(data.SecurityGroups[0].IpPermissions, callback);
				}
				return create(callback);
			});
		}
		function ensureIPAuthorized(records, callback) {
/*			
			var existing = _condenseRecords(records);
			if (existing.indexOf("tcp:22:22:" + clientPublicIP + "/32") === -1) {
				console.log(("Adding IP " + clientPublicIP + " for port 22 access to security group '" + groupName + "' on AWS.").magenta);
		        return self._api.ec2.authorizeSecurityGroupIngress({
		            GroupName: groupName,
		            IpPermissions: [
		                {
		                    UserIdGroupPairs: [],
		                    IpRanges: [ { CidrIp: clientPublicIP + "/32" } ],
		                    IpProtocol: "tcp",
		                    FromPort: 22,
		                    ToPort: 22
		                }
		            ]
		        }, function(err, response) {
		            if (err) return callback(err);
		            return callback(null);

		        });
		    } else {
				console.log("Verified that IP " + clientPublicIP + " access to port 80 is configured in security group '" + groupName + "' on AWS.");
		    }
*/
		    return callback(null);
		}
		return Q.denodeify(ensureGroupRecord)().then(function(records) {
			return Q.denodeify(ensureIPAuthorized)(records);
		});
	});
}

adapter.prototype._ensureKey = function(vm) {
	var self = this;
	return Q.denodeify(function (callback) {
		return self._api.ec2.describeKeyPairs({
			KeyNames: [
				vm.keyId
			]
		}, function (err, response) {
			function upload(callback) {
				console.log(("Uploading SSH key '" + vm.keyId + "' to AWS.").magenta);
				return self._api.ec2.importKeyPair({
					KeyName: vm.keyId,
					PublicKeyMaterial: new Buffer(vm.keyPub).toString("base64")
				}, function (err, response) {
					if (err) return callback(err);
					self._keyId = vm.keyId;
					return callback(null);
				});
			}
			if (err) {
				if (/^InvalidKeyPair\.NotFound:/.test(err.toString())) {
					return upload(callback);
				}
				return callback(err);
			}
			if (response.KeyPairs && response.KeyPairs.length === 1 && response.KeyPairs[0].KeyName === vm.keyId) {
				self._keyId = vm.keyId;
				console.log("Verified that SSH key is on AWS.");
				return callback(null);
			}
			return upload(callback);
		});
	})();
}

adapter.prototype._removeKey = function(vm) {
	var self = this;
	if (!self._keyId) return Q.resolve();
	console.log(("Removing SSH key '" + vm.keyId + "' from AWS.").magenta);
	return Q.denodeify(function (callback) {
		return self._api.ec2.deleteKeyPair({
			KeyName: vm.keyId
		}, function (err, response) {
			if (err) return callback(err);
			self._keyId = null;
			return callback(null);
		});
	})();
}

adapter.prototype._create = function(vm, pio) {
	var self = this;
	return self._ensureSecurityGroup(vm).then(function() {
		return self._ensureKey(vm).then(function() {
			console.log(("Creating new AWS EC2 instance with name: " + vm.name).magenta);
			return Q.denodeify(function (callback) {
				return self._api.ec2.runInstances({
					ImageId: vm.ImageId,
					MinCount: 1,
					MaxCount: 1,
					KeyName: self._keyId,
					SecurityGroups: [
						self._securityGroupId
					],
					InstanceType: vm.InstanceType,
					BlockDeviceMappings: vm.BlockDeviceMappings
				}, function (err, response) {
					if (err) return callback(err);
					if (!response.Instances || response.Instances.length !== 1) {
						return callback(new Error("Unexpected response: " + JSON.stringify(response)));
					}
					var instanceId = response.Instances[0].InstanceId;
					return self._api.ec2.createTags({
						Resources: [
							instanceId
						],
						Tags: [
							{
								Key: "Name",
								Value: vm.name
							}
						]
					}, function (err, response) {
						if (err) return callback(err);
						function waitUntilReady(callback) {
							return self._api.ec2.describeInstances({
								InstanceIds: [
									instanceId
								]
							}, function (err, response) {
								if (err) return callback(err);
								if (
									response.Reservations.length !== 1 ||
									response.Reservations[0].Instances.length !== 1
								) {
									return callback(new Error("Unexpected status response: " + JSON.stringify(response)));
								}
								if (response.Reservations[0].Instances[0].State.Name === "running") {
									return callback(null);
								}
								console.log("Waiting for vm to boot ...");
								return setTimeout(function() {
									return waitUntilReady(callback);
								}, 5 * 1000);
							});
						}
						return waitUntilReady(callback);
					});
				});
			})();
	    });
	}).then(function() {
		return self._getByName(vm.name);
	});
}

