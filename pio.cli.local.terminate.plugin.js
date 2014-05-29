
const ASSERT = require("assert");
const DEEPMERGE = require("deepmerge");
const FS = require("fs");


exports.terminate = function(pio, state) {

	var response = {
		status: "unknown"
	};

	return pio.API.Q.fcall(function() {

		if (!state["pio.cli.local"].ip) {
			throw "state['pio.cli.local'].ip not set!";
		}

		if (state["pio.cli.local"].ip !== pio.getConfig("config")["pio.vm"].ip) {
			throw "state['pio.cli.local'].ip != config['pio.vm'].ip";
		}

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

		var vm = {
			name: pio.getConfig("config")["pio.vm"].name,
			keyId: pio.getConfig("config")["pio.vm"].keyId,
			keyPub: pio.getConfig("config")["pio.vm"].keyPub,
			securityGroup: pio.getConfig("config")["pio.vm"].securityGroup
		};

		function terminateWithAdapter(name, settings) {
			// TODO: Use `require.async`.
			var adapter = require("./adapters/" + name);
			var adapter = new adapter.adapter(settings);
			console.log(("Terminate VM using adapter: " + name).magenta);
			if (!adapter.terminate) {
				return pio.API.Q.reject(new Error("Plugin at '" + require.resolve("./adapters/" + name) + "' does not yet implmenet method 'terminate'!"));
			}
			return adapter.terminate(DEEPMERGE(settings, vm));
		}

		return terminateWithAdapter(adapterName, adapterSettings).then(function(_state) {

			// If instance ID is bumeric, increment it.
			if ((""+parseInt(pio._state["pio"].instance)) === (""+pio._state["pio"].instance)) {
				console.log(("Incrementing 'config.pio.instance' with current value '" + pio._state["pio"].instance + "'").magenta);
				pio._state["pio"].instance = ""+(parseInt(pio._state["pio"].instance) + 1);
				pio._updateWorkspaceProfile({
					"config": {
						"pio": {
							"instance": pio._state["pio"].instance
						}
					}
				});
			}

			return pio._setRuntimeConfig({});
		});
	}).then(function() {

        return {};
    });
}
