
const ASSERT = require("assert");
const CRYPTO = require("crypto");
const Q = require("q");
const DIGIO = require("digitalocean-api");
const DEEPMERGE = require("deepmerge");
const WAITFOR = require("waitfor");

// @see https://developers.digitalocean.com/
// @see https://github.com/enzy/digitalocean-api


var adapter = exports.adapter = function(settings) {

	var self = this;

	self._settings = settings;

	ASSERT.equal(typeof self._settings.clientId, "string");
	ASSERT.equal(typeof self._settings.apiKey, "string");

	var api = new DIGIO(self._settings.clientId, self._settings.apiKey);
	self._api = {};
	for (var name in api) {
		if (typeof api[name] === "function") {
			(function inject(name) {
				self._api[name] = function() {
					var args = Array.prototype.slice.call(arguments, 0);
					return Q.nbind(api[name], api).apply(api, args);
				}
			})(name);
		}
	}

	self._keyId = null;
}

adapter.prototype.ensure = function(vm) {
	var self = this;

	ASSERT.equal(typeof vm.size, "string");

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
	return self._api.dropletGetAll().then(function(droplets) {
		if (!droplets) {
			throw new Error("Error listing droplet! Likely due to Digital Ocean API being down.");
		}
		droplets = droplets.filter(function(droplet) {
			return (droplet.name === name);
		});
		if (droplets.length > 1) {
			throw new Error("Found more than 1 dropplet with name '" + name + "'");
		}
		if (droplets.length === 0) {
			return null;
		}
		var droplet = droplets.shift();
		function formatInfo(droplet) {
			return {
				_raw: droplet,
				ip: droplet.ip_address || "",
				ipPrivate: droplet.private_ip_address || ""					
			};
		}
		if (droplet.status === "active") {
			return formatInfo(droplet);
		}
		function waitUntilReady(dropletId) {
			// TODO: Ensure we can never get into an infinite loop here. i.e. Add timeout.
			var deferred = Q.defer();
			function check() {
				return self._api.dropletGet(dropletId).then(function(droplet) {
					console.log("Waiting for vm to boot ...");
					if (droplet.status === "active") {
						return deferred.resolve(formatInfo(droplet));
					}
					setTimeout(check, 10 * 1000);
				}).fail(deferred.reject);
			}
			check();
			return deferred.promise;
		}
		return waitUntilReady(droplet.id);
	});
}

adapter.prototype._ensureKey = function(vm) {
	var self = this;
	return Q.fcall(function() {
		ASSERT.equal(typeof vm.keyId, "string");
		ASSERT.equal(typeof vm.keyPub, "string");
		var keyName = vm.keyId;
		return self._api.sshKeyGetAll().then(function(keys) {
			keys = keys.filter(function(key) {
				return (key.name === keyName);
			});
			if (keys.length === 0) {
				console.log(("Uploading SSH key '" + keyName + "' to Digital Ocean.").magenta);
				return self._api.sshKeyAdd(keyName, vm.keyPub).then(function(data) {
					self._keyId = data.id;
					return;
				});
			}
			self._keyId = keys.shift().id;
			console.log("Verified that SSH key is on Digital Ocean.");
			return;
		});
	});
}

adapter.prototype._removeKey = function(vm) {
	var self = this;
	// TODO: Bypass this if called with `--gc` which causes a more thorough GC.
	//       In which case we need to fetch `self._keyId` first.
	if (!self._keyId) return Q.resolve();
	console.log(("Removing SSH key '" + vm.keyId + "' from Digital Ocean.").magenta);
	return self._api.sshKeyDestroy(self._keyId).then(function() {
		self._keyId = null;
		return;
	});
}

adapter.prototype._create = function(vm, pio) {
	var self = this;
	return self._api.sizeGetAll().then(function(sizes) {
		return self._api.imageGetGlobal().then(function(images) {
			images = images.filter(function(image) {
				if (image.distribution !== "Ubuntu") return false;
				if (!/docker/i.test(image.name)) return false;
				return true;
			});
			if (images.length === 0) {
				throw new Error("No image found!");
			}
			if (images.length > 1) {
				console.log("WARN: Found more than 1 image:", images);
			}
			return self._ensureKey(vm).then(function() {
				var name = vm.name;
				var sizeId = sizes.filter(function(size) {
					if (size.slug == vm.size) return true;
					return false;
				});
				if (sizeId.length === 0) {
					console.log("sizes", sizes);
					throw new Error("Could not find size '" + vm.size + "' for slug value in sizes above!");
				}
				sizeId = sizeId.shift().id;
				var imageId = images[0].id;
				var regionId = 3;		// San Francisco 1
				var optionals = {
					ssh_key_ids: self._keyId,
					private_networking: false,
					backups_enabled: false
				};
				console.log(("Creating new Digital Ocean droplet with name: " + name).magenta);
				return self._api.dropletNew(name, sizeId, imageId, regionId, optionals).then(function(droplet) {
					if (!droplet) {
						throw new Error("Error creating droplet! Likely due to Digital Ocean API being down.");
					}
					function waitUntilReady(eventId) {
						// TODO: Ensure we can never get into an infinite loop here. i.e. Add timeout.
						var deferred = Q.defer();
						function check() {
							self._api.eventGet(eventId).then(function(event) {
								
								console.log("Waiting for vm to boot ...", (event.percentage || 0), "%");

								if (event.action_status === "done") {
									return deferred.resolve();
								}
								setTimeout(check, 10 * 1000);
							}).fail(deferred.reject);
						}
						check();
						return deferred.promise;
					}
					return waitUntilReady(droplet.event_id);
				});
			});
		});
	}).then(function() {
		return self._getByName(vm.name);
	});
}

