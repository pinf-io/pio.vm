
const ASSERT = require("assert");
const CRYPTO = require("crypto");
const Q = require("q");
const DO = require("do-wrapper");
const DEEPMERGE = require("deepmerge");
const WAITFOR = require("waitfor");

// @see https://developers.digitalocean.com/
// @see https://github.com/enzy/digitalocean-api


var adapter = exports.adapter = function(settings) {

	var self = this;

	self._settings = settings;

	ASSERT.equal(typeof self._settings.token, "string");
	ASSERT.equal(typeof self._settings.tokenName, "string");

	var api = new DO(self._settings.token, 250);
	self._api = {};
	for (var name in api) {
		if (typeof api[name] === "function") {
			(function inject(name) {
				self._api[name] = function() {
					var args = Array.prototype.slice.call(arguments, 0);
					return Q.nbind(api[name], api).apply(api, args).then(function (data) {
						if (!data) {
							throw new Error("No data for call '" + name + "'");
						}
						if (data.id === "unauthorized") {
							throw new Error("Error: " + JSON.stringify(data, null, 4));
						}
						return data;
					});
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

adapter.prototype.terminate = function(vm) {
	var self = this;

	return self._getByName(vm.name).then(function(vmInfo) {
		if (vmInfo) {
			console.log(("Terminating: " + JSON.stringify(vmInfo, null, 4)).magenta);
			return self._api.dropletsDeleteDroplet(vmInfo._raw.id).then(function(eventId) {
				// TODO: Optionally wait until destroyed?
			});
		}
		return Q.reject("VM with name '" + vm.name + "' not found!");
	});
}

adapter.prototype._getByName = function(name) {
	var self = this;
	return self._api.dropletsGetAll().then(function(droplets) {
		if (!droplets) {
			throw new Error("Error listing droplet! Likely due to Digital Ocean API being down.");
		}
console.log("droplets", droplets);		
		droplets = droplets.droplets.filter(function(droplet) {
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
			var info = {
				_raw: droplet,
				ip: "",
				ipPrivate: ""
			};
			droplet.networks.v4.forEach(function (network) {
				if (network.type === "public") {
					info.ip = network.ip_address;
				} else
				// TODO: Verify that the type is in fact called `private`.
				if (network.type === "private") {
					info.ipPrivate = network.ip_address;
				}
			});
			return info;
		}
		if (droplet.status === "active") {
			return formatInfo(droplet);
		}
		function waitUntilReady(dropletId) {
			// TODO: Ensure we can never get into an infinite loop here. i.e. Add timeout.
			var deferred = Q.defer();
			function check() {
				return self._api.dropletsGetDropletById(dropletId).then(function(droplet) {
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
		return self._api.keysGetAll().then(function(keys) {
			keys = keys.ssh_keys.filter(function(key) {
				return (key.name === keyName);
			});
			if (keys.length === 0) {
				console.log(("Uploading SSH key '" + keyName + "' to Digital Ocean.").magenta);
				return self._api.keysAddNew(keyName, vm.keyPub).then(function(data) {
					self._keyId = data.ssh_key.id;
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
	return self._api.keysDestroyKey(self._keyId).then(function() {
		self._keyId = null;
		return;
	});
}

adapter.prototype._create = function(vm) {
	var self = this;
	return self._api.sizesGetAll().then(function(sizes) {
		return self._api.imagesGetAll().then(function(images) {
			return self._api.regionsGetAll().then(function(regions) {
				console.log("regions", regions);
				console.log("sizes", sizes);
				console.log("self._settings", self._settings);
				self._settings.distribution = self._settings.distribution || "Ubuntu";
				self._settings.imageName = self._settings.imageName || "Docker.+Ubuntu.+14";
				console.log("self._settings", self._settings);
				console.log("Available images:");
				images = images.images.filter(function(image) {
					console.log("  " + image.distribution + " - " + image.name + " (" + image.id + ")");
					if (image.distribution !== self._settings.distribution) return false;
					if (!new RegExp(self._settings.imageName).exec(image.name)) return false;
					return true;
				});
				if (images.length === 0) {
					throw new Error("No image found!", images, self._settings);
				}
				if (images.length > 1) {
					console.log("WARN: Found more than 1 image:", images, self._settings);
				}
				console.log("Chosen image: " + JSON.stringify(images[0]));
				return self._ensureKey(vm).then(function() {

					if (!self._keyId) {
						throw new Error("'self._keyId' not set!");
					}

					var name = vm.name;

					// TODO: Move into default config.
					vm.region = vm.region || "sfo1";

					var regionId = regions.regions.filter(function(region) {
						if (region.slug == vm.region) return true;
						return false;
					});
					if (regionId.length === 0) {
						console.log("regions", regions);
						throw new Error("Could not find region '" + vm.region + "' for slug value in regions above!");
					}
					regionId = regionId.shift().slug;

					var sizeId = sizes.sizes.filter(function(size) {
						if (size.slug == vm.size) return true;
						return false;
					});
					if (sizeId.length === 0) {
						console.log("sizes", sizes);
						throw new Error("Could not find size '" + vm.size + "' for slug value in sizes above!");
					}
					sizeId = sizeId.shift();
					if (sizeId.regions.indexOf(regionId) === -1) {
						throw new Error("Size '" + vm.size + "' is not supported by region '" + vm.region + "'!");
					}
					sizeId = sizeId.slug;

					var imageId = images[0].id;
					var optionals = {
						ssh_keys: [
							self._keyId
						],
						private_networking: false,
						backups: false,
						ipv6: false
					};
					console.log(("Creating new Digital Ocean droplet with name: " + name + " and info " + JSON.stringify([name, regionId, sizeId, imageId, optionals], null, 4) + " using token '" + self._settings.tokenName + "'").magenta);
					return self._api.dropletsCreateNewDroplet(name, regionId, sizeId, imageId, optionals).then(function(droplet) {
						if (!droplet) {
							throw new Error("Error creating droplet! Likely due to Digital Ocean API being down.");
						}
						function waitUntilReady(dropletId, actionId) {
							// TODO: Ensure we can never get into an infinite loop here. i.e. Add timeout.
							var deferred = Q.defer();
							function check() {
								self._api.dropletActionGetStatus(dropletId, actionId).then(function (action) {

									console.log("Waiting for vm to boot ...");

									if (action.action.status === "completed") {
										return deferred.resolve();
									}
									setTimeout(check, 10 * 1000);
								}).fail(deferred.reject);
							}
							check();
							return deferred.promise;
						}
						if (droplet.id === "unprocessable_entity") {
							throw new Error("Error creating dropplet: " + JSON.stringify(droplet));
						}
						return waitUntilReady(droplet.droplet.id, droplet.links.actions[0].id);
					});
				});
			});
		});
	}).then(function() {
		return self._getByName(vm.name);
	});
}

