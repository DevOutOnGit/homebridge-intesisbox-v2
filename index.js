// Intesisbox WMP bridge V2

const EventEmitter = require("events")
const net = require("net");

var Accessory, Service, Characteristic, UUIDGen;

module.exports = function(homebridge){
  Accessory = homebridge.platformAccessory;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;

  homebridge.registerAccessory("homebridge-intesisbox-v2", "Intesisbox", Intesisbox);
};

const NULL_VALUE = "32768";

class Intesisbox extends EventEmitter {
  constructor(log, config) {
    super();

    this.log = log;

    // Config

    this.name = config.name || "Intesisbox";
    this.host = config.host;
    this.port = config.port || 3310;
    this.number = config.number || 1;
    
    this.pingCount = 0;

    if (!this.host) {
      this.log.error("Missing host, cannot connect to device");
      return;
    }

    // HomeKit services and characteristics

    this.informationService = new Service.AccessoryInformation();

    // Required Characteristics
    this.informationService.setCharacteristic(Characteristic.Manufacturer, "Intesis");
    this.informationService.setCharacteristic(Characteristic.Name, this.name);

    // Cannot be done with the hardware:
    // (although it would be great to be able to flash the LED or something)
    // Characteristic.Identify

    // Set by ID once connected to the device:
    // Characteristic.Model
    // Characteristic.SerialNumber
    // Characteristic.FirmwareRevision

    // Optional Characteristics
    // Characteristic.HardwareRevision
    // Characteristic.AccessoryFlags

    this.thermostatService = new Service.Thermostat();

    // Required Characteristics

    this.thermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .on("get", function(callback) {
        if (this.state.onoff == "ON") {
          if (this.state.mode == "AUTO") {
            // If AUTO, guess based on current and target temperature
            if (this.state.ambtemp < this.state.setptemp) {
              callback(null, Characteristic.CurrentHeatingCoolingState.HEAT);
            } else {
              callback(null, Characteristic.CurrentHeatingCoolingState.COOL);
            }
          } else if (this.state.mode == "HEAT") {
            callback(null, Characteristic.CurrentHeatingCoolingState.HEAT);
          } else if (this.state.mode == "COOL") {
            callback(null, Characteristic.CurrentHeatingCoolingState.COOL);
          } else {
            // Unknown, call it "OFF"
            callback(null, Characteristic.CurrentHeatingCoolingState.OFF);
          }
        } else {
          callback(null, Characteristic.CurrentHeatingCoolingState.OFF);
        }
      }.bind(this));

    this.thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .on("get", function(callback) {
        if (this.state.onoff == "ON") {
          if (this.state.mode == "AUTO") {
            callback(null, Characteristic.TargetHeatingCoolingState.AUTO);
          } else if (this.state.mode == "HEAT") {
            callback(null, Characteristic.TargetHeatingCoolingState.HEAT);
          } else if (this.state.mode == "COOL") {
            callback(null, Characteristic.TargetHeatingCoolingState.COOL);
          } else {
            // Unknown, call it "OFF"
            callback(null, Characteristic.TargetHeatingCoolingState.OFF);
          }
        } else {
          callback(null, Characteristic.TargetHeatingCoolingState.OFF);
        }
      }.bind(this))
      .on("set", function(value, callback) {
        if (value == Characteristic.TargetHeatingCoolingState.OFF) {
          this.sendSET("ONOFF", "OFF", function() { callback(); });
        } else {
          var mode;
          if (value == Characteristic.TargetHeatingCoolingState.AUTO) {
            mode = "AUTO";
          } else if (value == Characteristic.TargetHeatingCoolingState.HEAT) {
            mode = "HEAT";
          } else if (value == Characteristic.TargetHeatingCoolingState.COOL) {
            mode = "COOL";
          }
          this.sendSET("MODE", mode, function() {
            if (this.state.onoff == "OFF") {
              this.sendSET("ONOFF", "ON", function() { callback(); });
            } else {
             callback();
            }
          }.bind(this));
        }
      }.bind(this));

    this.thermostatService.getCharacteristic(Characteristic.CurrentTemperature)
      .on("get", function(callback) {
        // Intesisbox returns celcius * 10 as a string, i.e. 18.5ºC is "185"
        callback(null, parseInt(this.state.ambtemp) / 10);
      }.bind(this));

    this.thermostatService.getCharacteristic(Characteristic.TargetTemperature)
      .on("get", function(callback) {
        // Intesisbox returns celcius * 10 as a string, i.e. 18.5ºC is "185"
        callback(null, parseInt(this.state.setptemp) / 10);
      }.bind(this))
      .on("set", function(value, callback) {
        // Intesisbox wants celcius * 10 as a string, i.e. 18.5ºC as "185"
        this.sendSET("SETPTEMP", Math.round(value * 10).toString(), function() { callback(); });
      }.bind(this));

    // Intesisbox cannot be changed, and does not display the temperature
    this.thermostatService.setCharacteristic(Characteristic.TemperatureDisplayUnits, Characteristic.TemperatureDisplayUnits.CELCIUS);

    // Optional Characteristics
    this.thermostatService.setCharacteristic(Characteristic.Name, this.name);
    // Characteristic.CurrentRelativeHumidity
    // Characteristic.TargetRelativeHumidity
    // Characteristic.CoolingThresholdTemperature
    // Characteristic.HeatingThresholdTemperature

    this.fanService = new Service.Fan();

    this.fanService.getCharacteristic(Characteristic.TargetFanState)
    .on("get", function(callback) {

      if (this.state.fansp) {
        switch (this.state.fansp) {
          case 'AUTO': // auto
            callback(null, '1');
            break;
          default:
          callback(null, '0');
        }
      } else {
        callback(communicationError);
      }

    }.bind(this))
    .on("set", function(state, callback, context) {

     var FANSP;
 
      if (state == '1') {
        this.fanService.updateCharacteristic(Characteristic.RotationSpeed, 100);
        FANSP = 'AUTO';
      } else {
        this.fanService.updateCharacteristic(Characteristic.RotationSpeed, 100);
        FANSP = '4';
      }
 
     this.sendSET("FANSP", FANSP, function() { callback(); });

    }.bind(this));

    this.fanService.getCharacteristic(Characteristic.RotationSpeed)
    .setProps({
      minStep: 25
    })
    .on("get", function(callback) {

      if (this.state.fansp) {
        switch (this.state.fansp) {
          case '1': // low
            callback(null, 25);
            break;
          case '2': // normal
            callback(null, 50);
            break;
          case '3': // high
            callback(null, 75);
            break;
          case '4': // max
            callback(null, 100);
            break;
          default:
            callback(null, 0);
        }
      } else {
        callback(communicationError);
      }
      
    }.bind(this))
    .on("set", function(speed, callback, context) {
      
      var FANSP;
      
      if (speed <= 25) {
        FANSP = '1';
      } else if (speed <= 50) {
        FANSP = '2';
      } else if (speed <= 75) {
        FANSP = '3';
      } else if (speed <= 100) {
        FANSP = '4';
      }

      this.fanService.updateCharacteristic(Characteristic.TargetFanState, 0);

      this.sendSET("FANSP", FANSP, function() { callback(); });

    }.bind(this));
  
    this.services = [
      this.informationService,
      this.thermostatService,
      this.fanService,
    ];

    // Device communications and handlers
    this.identity = {};
    this.on("ID", this.onID.bind(this));

    this.info = {};
    this.on("INFO", this.onINFO.bind(this));

    // We'll listen to the Intesisbox and populate state with the current known
    // state on changes
    this.state = {}
    this.on("CHN," + this.number, this.onCHN.bind(this));

    this.connect();
  }

  // Device communications

  connect(callback) {
    this.buffer = "";
    this.log("Connecting to Intesisbox at "+this.host+":"+this.port)
    this.socket = net.connect(this.port, this.host, this.onSocketConnect.bind(this));
    this.socket.on("error", this.onSocketError.bind(this));
    this.socket.on("close", this.onSocketClose.bind(this));
    this.socket.on("line", this.onSocketLine.bind(this));
    this.socket.on("data", this.onSocketData.bind(this));
  }

  onSocketConnect() {
    // Ask for identifying information
    this.sendID();

    // Ask for the initial state
    this.sendGET("*");
    
    // HACK: ping device every 60 seconds to keep connection alive
    this.sendPING();
  }

  onSocketData(data) {
    this.buffer += data;
    var n = this.buffer.indexOf("\n");
    while (~n) {
      var line = this.buffer.substring(0, n);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      this.socket.emit("line", line);
      this.buffer = this.buffer.substring(n + 1);
      n = this.buffer.indexOf("\n");
    }
  }

  onSocketLine(line) {
    var [code, rest] = line.split(":", 2);
    if (code == "ID") {
      this.log.debug("Received identify:", rest)
      this.emit("ID", rest);
    } else if (code == "INFO") {
      var [name, value] = rest.split(",", 2);
      this.log.debug("Received info:", name, "=", value)
      this.emit("INFO", name, value);
    } else if (code == "ACK") {
      this.log.debug("Received ack")
      this.emit("ACK");
    } else if (code == "CHN," + this.number) {
      var [name, value] = rest.split(",", 2);

      this.log.debug("Received Change:", name, value)
      this.emit("CHN," + this.number, name, value);
      this.emit("CHN," + this.number + ":" + name, value);
    } else {
      this.log.debug("Received unknown message:", code, rest);
    }
  }

  onSocketError(error) {
    this.log.error("Connection error:", error);
  }

  onSocketClose() {
    this.log("Connection unexpectedly closed, reconnecting in 15 seconds");
    setTimeout(function() {
      this.connect();
    }.bind(this), 15000);
  }

  onID(id) {
    //ID:Model,MAC,IP,Protocol,Version,RSSI,Name,(unknown)
    var [model, mac, ip, protocol, version, rssi, name, _] = id.split(",");

    this.identity = {model, mac, ip, protocol, version, rssi, name};

    this.informationService.setCharacteristic(Characteristic.Model, model);
    this.informationService.setCharacteristic(Characteristic.SerialNumber, mac);
    this.informationService.setCharacteristic(Characteristic.Name, name);
    this.informationService.setCharacteristic(Characteristic.FirmwareRevision, version);
	
	this.log("ID", model, version);
  }

  onINFO(name, value) {
    this.info[name] = value;
  }

  onCHN(name, value) {
    if (name == "ONOFF") {
      this.state.onoff = value;
      if (value == "ON" ) {
        this.log("Powered ON")
      } else if (value == "OFF") {
        this.log("Powered OFF")
      } else {
        this.log.warn("Unknown ONOFF value:", value)
      }
    } else if (name == "MODE") {
      this.state.mode = value;
      if (value == "AUTO" ) {
        this.log("AUTO mode")
      } else if (value == "HEAT") {
        this.log("HEAT mode")
      } else if (value == "COOL") {
        this.log("COOL mode")
      } else if (value == "FAN") {
        this.log("FAN mode (unsupported in HomeKit)")
      } else if (value == "DRY") {
        this.log("DRY mode (unsupported in HomeKit)")
      } else {
        this.log.warn("Unknown mode:", value)
      }
    } else if (name == "SETPTEMP") {
      this.state.setptemp = value;
      this.log("Target temperature:", value/10);
    } else if (name == "FANSP") {
      this.state.fansp = value;
      this.log("Fanspeed:", value);
    } else if (name == "VANEUD") {
      this.state.vaneud = value;
      this.log("Vertical vane:", value);
    } else if (name == "VANELR") {
      this.state.vanelr = value;
      this.log("Horizontal vane:", value);
    } else if (name == "ERRSTATUS") {
      this.state.errstatus = value;
      this.log.debug("Error status:", value);
    } else if (name == "ERRCODE") {
      this.state.errcode = value;
      this.log.debug("Error code:", value);
    } else if (name == "AMBTEMP") {
      this.state.ambtemp = value;
      this.log("Ambient temperature:", value/10);
    }
  }

  send(command) {
    this.log.debug("Send:", command);
    this.socket.write(command + "\r\n");
  }

  sendID(callback) {
    if (callback) {
      this.once("ID", function(value) { callback(null, value) });
    }
    this.send("ID");
  }

  sendPING(callback) {
    if (callback) {
      this.once("PING", function(value) { callback(null, value) });
    }
    
    this.pingCount += 1;
    
    // Force update ambient temperature every 10 pings (10 minutes)
    //
    // if(this.pingCount % 10 == 0) {
    	// this.sendGET("AMBTEMP");
    // } else {
	    this.send("PING");
    // }
    
    setTimeout(function() {
	   this.sendPING();
    }.bind(this), 60000);

  }

  sendINFO(callback) {
    if (callback) {
      this.once("INFO", function(value) { callback(null, value) });
    }
    this.send("INFO");
  }

  sendGET(name, callback) {
    if (callback) {
      this.once("CHN," + this.number + ":" + name, function(value) { callback(null, value) });
    }
    this.send("GET," + this.number + ":" + name);
  }

  sendSET(name, value, callback) {
    if (callback) {
      this.once("ACK", function(value) { callback(null, value) });
    }
    this.send("SET," + this.number + ":" + name + "," + value);
  }

  // HomeKit integration

  getServices() {
    return this.services;
  }
}
