
const ASSERT = require("assert");
const NET = require("net");
const DEEPMERGE = require("deepmerge");
const FS = require("fs");


exports.ensure = function(pio, state) {

	var response = {
		".status": "unknown"
	};

    function isSshAvailable(ip) {
        var deferred = pio.API.Q.defer();
        var timeout = setTimeout(function() {
            console.error("Timeout! Could not connect to: tcp://" + ip + ":22");
            return deferred.resolve(false);
        }, 1000);
        var client = NET.connect({
            host: ip,
            port: 22
        }, function() {
            clearTimeout(timeout);
            client.destroy();
            return deferred.resolve(true);
        });
        client.on('error', function(err) {
            clearTimeout(timeout);
            client.destroy();
            return deferred.resolve(false);
        });
        return deferred.promise;
    }

	return pio.API.Q.fcall(function() {

		if (!pio.getConfig("config")["pio.vm"].adapter) {
			throw "config['pio.vm'].adapter not set!";
		}

		var adapterName = pio.getConfig("config")["pio.vm"].adapter;

		if (pio.getConfig("config")["pio.vm"].adapterSettings) {
			console.log("DEPRECATED use of config['pio.vm'].adapterSettings. Use config['pio.vm'].adapters[<name>] instead.");
			pio.getConfig("config")["pio.vm"].adapters = {};
			pio.getConfig("config")["pio.vm"].adapters[adapterName] = pio.getConfig("config")["pio.vm"].adapterSettings;
			delete pio.getConfig("config")["pio.vm"].adapterSettings;
		}

		var adapterSettings = pio.getConfig("config")["pio.vm"].adapters[adapterName];

		if (!adapterSettings) {
			throw "Adapter config not found at: config['pio.vm'].adapters['" + adapterName + "']";
		}

		if (!adapterSettings.user) {
			throw "config['pio.vm'].adapters['" + adapterName + "'].user not set!";
		}

		response.user = adapterSettings.user;


		return pio.API.Q.fcall(function() {
			if (!state["pio.vm"].ip) {
				response.sshAvailable = false;
	    		return;
			}
		    return isSshAvailable(state["pio.vm"].ip).then(function(sshAvailable) {
		    	response.ip = state["pio.vm"].ip;
		    	response.sshAvailable = sshAvailable;
	    		return;
		    });
		}).then(function() {

			if (response.sshAvailable) {
				return;
			}

			if (state["pio.vm"].create === false) {
				console.log(("Skip create due to 'config[pio.vm].create === false'.").yellow);
	    		return;
			}

			if (state["pio.vm"] && state["pio.vm"].skip && state["pio.vm"].skip.indexOf("provision") !== -1) {
				// We are being asked to skip VM provisioning.
				console.log("Skip VM provisioning");
				return;
			}

			var vm = {
				name: pio.getConfig("config")["pio.vm"].name,
				keyId: pio.getConfig("config")["pio.vm"].keyId,
				keyPub: pio.getConfig("config")["pio.vm"].keyPub,
				securityGroup: pio.getConfig("config")["pio.vm"].securityGroup
			};

			console.log(("Ensuring VM: " + JSON.stringify(vm, null, 4)).magenta);

			function ensureWithAdapter(name, settings) {
				try {
					// TODO: Use `require.async`.
					var adapter = require("./adapters/" + name);
					var adapter = new adapter.adapter(settings);
					console.log(("Ensuring VM using adapter: " + name).magenta);
				} catch (err) {
					console.log("settings", settings);
					throw err;
				}
				return adapter.ensure(DEEPMERGE(settings, vm));
			}

			return ensureWithAdapter(adapterName, adapterSettings).then(function(_state) {
				response = DEEPMERGE(response, _state);

				return pio._setRuntimeConfig({
					config: {
						"pio": {
							hostname: pio.getConfig("config")["pio"].hostname
						},
						"pio.vm": {
							ip: response.ip
						}
					}
				});
			}).then(function() {

				function check() {
				    return isSshAvailable(response.ip).then(function(sshAvailable) {
				    	response.sshAvailable = sshAvailable;
				    	if (response.sshAvailable) {
					    	console.log("Port 22 is now open!");
				    		return;
				    	}
				    	console.log("Waiting for port 22 to open up ...");
				    	return pio.API.Q.delay(3000).then(function() {
				    		return check();
				    	});
					});
				}

				return pio.API.Q.timeout(check(), 120 * 1000).fail(function(err) {
		    		console.error(("\nACTION: Call 'pio deploy' again!\n\n").red);
		    		throw err;
		    	});
			});
		});
	}).then(function() {
		response[".status"] = "pending";		
    	if (response.sshAvailable) {
    		response[".status"] = "ready";
    	}
    	return;
	}).then(function() {

        return {
        	"pio.vm": response
        };
    });
}
