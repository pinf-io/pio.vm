
const ASSERT = require("assert");
const NET = require("net");
const DEEPMERGE = require("deepmerge");
const FS = require("fs");


exports.ensure = function(pio, state) {

	var response = {
		status: "unknown"
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

		var vm = {
			name: pio.getConfig("config")["pio.vm"].name,
			keyId: pio.getConfig("config")["pio.vm"].keyId,
			keyPub: pio.getConfig("config")["pio.vm"].keyPub,
			securityGroup: pio.getConfig("config")["pio.vm"].securityGroup
		};

		console.log(("Creating VM: " + JSON.stringify(vm, null, 4)).magenta);

		function ensureWithAdapter(name, settings) {
			// TODO: Use `require.async`.
			var adapter = require("./adapters/" + name);
			var adapter = new adapter.adapter(settings);
			console.log(("Creating VM using adapter: " + name).magenta);
			return adapter.ensure(DEEPMERGE(settings, vm));
		}

		return ensureWithAdapter(pio.getConfig("config")["pio.vm"].adapter, pio.getConfig("config")["pio.vm"].adapterSettings).then(function(_state) {
			response = DEEPMERGE(response, _state);

			return pio._setRuntimeConfig({
				config: {
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

			return pio.API.Q.timeout(check(), 60 * 1000);
		});

	}).then(function() {
		response.status = "pending";		
    	if (response.sshAvailable) {
    		response.status = "ready";
    	}
    	return;
	}).then(function() {

        return {
        	"pio.vm": response
        };
    });
}
