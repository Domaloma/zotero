/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2011 Center for History and New Media
                     George Mason University, Fairfax, Virginia, USA
                     http://zotero.org
    
    This file is part of Zotero.
    
    Zotero is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
    
    Zotero is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.
    
    You should have received a copy of the GNU Affero General Public License
    along with Zotero.  If not, see <http://www.gnu.org/licenses/>.
    
    ***** END LICENSE BLOCK *****
*/

Zotero.Server = new function() {
	var _onlineObserverRegistered, serv;
	this.responseCodes = {
		200:"OK",
		201:"Created",
		204:"No Content",
		300:"Multiple Choices",
		400:"Bad Request",
		404:"Not Found",
		409:"Conflict",
		412:"Precondition Failed",
		500:"Internal Server Error",
		501:"Not Implemented",
		504:"Gateway Timeout"
	};
	
	/**
	 * initializes a very rudimentary web server
	 */
	this.init = function(port, bindAllAddr, maxConcurrentConnections) {
		if (Zotero.HTTP.browserIsOffline()) {
			Zotero.debug('Browser is offline -- not initializing HTTP server');
			_registerOnlineObserver();
			return;
		}
		
		if(serv) {
			Zotero.debug("Already listening on port " + serv.port);
			return;
		}
		
		// start listening on socket
		serv = Components.classes["@mozilla.org/network/server-socket;1"]
					.createInstance(Components.interfaces.nsIServerSocket);
		try {
			// bind to a random port on loopback only
			serv.init(port ? port : Zotero.Prefs.get('httpServer.port'), !bindAllAddr, -1);
			serv.asyncListen(Zotero.Server.SocketListener);
			
			Zotero.debug("HTTP server listening on "+(bindAllAddr ? "*": " 127.0.0.1")+":"+serv.port);
			
			// Close port on Zotero shutdown (doesn't apply to translation-server)
			if (Zotero.addShutdownListener) {
				Zotero.addShutdownListener(this.close.bind(this));
			}
		} catch(e) {
			Zotero.logError(e);
			Zotero.debug("Not initializing HTTP server");
			serv = undefined;
		}
		
		_registerOnlineObserver()
	}
	
	/**
	 * releases bound port
	 */
	this.close = function() {
		if(!serv) return;
		serv.close();
		serv = undefined;
	};
	
	/**
	 * Parses a query string into a key => value object
	 * @param {String} queryString Query string
	 */
	this.decodeQueryString = function(queryString) {
		var splitData = queryString.split("&");
		var decodedData = {};
		for (let variable of splitData) {
			var splitIndex = variable.indexOf("=");
			decodedData[decodeURIComponent(variable.substr(0, splitIndex))] = decodeURIComponent(variable.substr(splitIndex+1));
		}
		return decodedData;
	}
	
	function _registerOnlineObserver() {
		if (_onlineObserverRegistered) {
			return;
		}
		
		// Observer to enable the integration when we go online
		var observer = {
			observe: function(subject, topic, data) {
				if (data == 'online') {
					Zotero.Server.init();
				}
			}
		};
		
		var observerService =
			Components.classes["@mozilla.org/observer-service;1"]
				.getService(Components.interfaces.nsIObserverService);
		observerService.addObserver(observer, "network:offline-status-changed", false);
		
		_onlineObserverRegistered = true;
	}
}

Zotero.Server.SocketListener = new function() {
	this.onSocketAccepted = onSocketAccepted;
	this.onStopListening = onStopListening;
	
	/*
	 * called when a socket is opened
	 */
	function onSocketAccepted(socket, transport) {
		// get an input stream
		var iStream = transport.openInputStream(0, 0, 0);
		var oStream = transport.openOutputStream(Components.interfaces.nsITransport.OPEN_BLOCKING, 0, 0);
		
		var dataListener = new Zotero.Server.DataListener(iStream, oStream);
		var pump = Components.classes["@mozilla.org/network/input-stream-pump;1"]
							 .createInstance(Components.interfaces.nsIInputStreamPump);
		pump.init(iStream, -1, -1, 0, 0, false);
		pump.asyncRead(dataListener, null);
	}
	
	function onStopListening(serverSocket, status) {
		Zotero.debug("HTTP server going offline");
	}
}

/*
 * handles the actual acquisition of data
 */
Zotero.Server.DataListener = function(iStream, oStream) {
	this.header = "";
	this.headerFinished = false;
	
	this.body = "";
	this.bodyLength = 0;
	
	this.iStream = iStream;
	this.oStream = oStream;
	this.sStream = Components.classes["@mozilla.org/scriptableinputstream;1"]
	                         .createInstance(Components.interfaces.nsIScriptableInputStream);
	this.sStream.init(iStream);
	
	this.foundReturn = false;
}

/*
 * called when a request begins (although the request should have begun before
 * the DataListener was generated)
 */
Zotero.Server.DataListener.prototype.onStartRequest = function(request, context) {}

/*
 * called when a request stops
 */
Zotero.Server.DataListener.prototype.onStopRequest = function(request, context, status) {
	this.iStream.close();
	this.oStream.close();
}

/*
 * called when new data is available
 */
Zotero.Server.DataListener.prototype.onDataAvailable = function(request, context,
                                                             inputStream, offset, count) {
	var readData = this.sStream.read(count);
	
	if(this.headerFinished) {	// reading body
		this.body += readData;
		// check to see if data is done
		this._bodyData();
	} else {					// reading header
		// see if there's a magic double return
		var lineBreakIndex = readData.indexOf("\r\n\r\n");
		if(lineBreakIndex != -1) {
			if(lineBreakIndex != 0) {
				this.header += readData.substr(0, lineBreakIndex+4);
				this.body = readData.substr(lineBreakIndex+4);
			}
			
			this._headerFinished();
			return;
		}
		var lineBreakIndex = readData.indexOf("\n\n");
		if(lineBreakIndex != -1) {
			if(lineBreakIndex != 0) {
				this.header += readData.substr(0, lineBreakIndex+2);
				this.body = readData.substr(lineBreakIndex+2);
			}
			
			this._headerFinished();
			return;
		}
		if(this.header && this.header[this.header.length-1] == "\n" &&
		   (readData[0] == "\n" || readData[0] == "\r")) {
			if(readData.length > 1 && readData[1] == "\n") {
				this.header += readData.substr(0, 2);
				this.body = readData.substr(2);
			} else {
				this.header += readData[0];
				this.body = readData.substr(1);
			}
			
			this._headerFinished();
			return;
		}
		this.header += readData;
	}
}

/*
 * processes an HTTP header and decides what to do
 */
Zotero.Server.DataListener.prototype._headerFinished = function() {
	this.headerFinished = true;
	
	Zotero.debug(this.header, 5);
	
	const methodRe = /^([A-Z]+) ([^ \r\n?]+)(\?[^ \r\n]+)?/;
	const hostRe = /[\r\n]Host: *(localhost|127\.0\.0\.1)(:[0-9]+)?[\r\n]/i;
	const contentTypeRe = /[\r\n]Content-Type: *([^ \r\n]+)/i;
	
	if(!Zotero.isServer) {
		const originRe = /[\r\n]Origin: *([^ \r\n]+)/i;
		var m = originRe.exec(this.header);
		if(m) {
			this.origin = m[1];
		} else {
			const bookmarkletRe = /[\r\n]Zotero-Bookmarklet: *([^ \r\n]+)/i;
			var m = bookmarkletRe.exec(this.header);
			if(m) this.origin = "https://www.zotero.org";
		}
		
		// Make sure the Host header is set to localhost/127.0.0.1 to prevent DNS rebinding attacks
		if (!hostRe.exec(this.header)) {
			this._requestFinished(this._generateResponse(400, "text/plain", "Invalid Host header\n"));
			return;
		}
	}
	
	// get first line of request
	var method = methodRe.exec(this.header);
	// get content-type
	var contentType = contentTypeRe.exec(this.header);
	if(contentType) {
		var splitContentType = contentType[1].split(/\s*;/);
		this.contentType = splitContentType[0];
	}
	
	if(!method) {
		this._requestFinished(this._generateResponse(400, "text/plain", "Invalid method specified\n"));
		return;
	}
	if(!Zotero.Server.Endpoints[method[2]]) {
		this._requestFinished(this._generateResponse(404, "text/plain", "No endpoint found\n"));
		return;
	}
	this.pathname = method[2];
	this.endpoint = Zotero.Server.Endpoints[method[2]];
	this.query = method[3];
	
	if(method[1] == "HEAD" || method[1] == "OPTIONS") {
		this._requestFinished(this._generateResponse(200));
	} else if(method[1] == "GET") {
		this._processEndpoint("GET", null); // async
	} else if(method[1] == "POST") {
		const contentLengthRe = /[\r\n]Content-Length: +([0-9]+)/i;
		
		// parse content length
		var m = contentLengthRe.exec(this.header);
		if(!m) {
			this._requestFinished(this._generateResponse(400, "text/plain", "Content-length not provided\n"));
			return;
		}
		
		this.bodyLength = parseInt(m[1]);
		this._bodyData();
	} else {
		this._requestFinished(this._generateResponse(501, "text/plain", "Method not implemented\n"));
		return;
	}
}

/*
 * checks to see if Content-Length bytes of body have been read and, if so, processes the body
 */
Zotero.Server.DataListener.prototype._bodyData = function() {
	if(this.body.length >= this.bodyLength) {
		// convert to UTF-8
		var dataStream = Components.classes["@mozilla.org/io/string-input-stream;1"]
		                           .createInstance(Components.interfaces.nsIStringInputStream);
		dataStream.setData(this.body, this.bodyLength);
		
		var utf8Stream = Components.classes["@mozilla.org/intl/converter-input-stream;1"]
		                           .createInstance(Components.interfaces.nsIConverterInputStream);
		utf8Stream.init(dataStream, "UTF-8", 4096, "?");
		
		this.body = "";
		var string = {};
		while(utf8Stream.readString(this.bodyLength, string)) {
			this.body += string.value;
		}		
		
		// handle envelope
		this._processEndpoint("POST", this.body); // async
	}
}
	
/**
 * Generates the response to an HTTP request
 */
Zotero.Server.DataListener.prototype._generateResponse = function(status, contentType, body) {
	var response = "HTTP/1.0 "+status+" "+Zotero.Server.responseCodes[status]+"\r\n";
	if(!Zotero.isServer) {
		response += "X-Zotero-Version: "+Zotero.version+"\r\n";
		response += "X-Zotero-Connector-API-Version: "+CONNECTOR_API_VERSION+"\r\n";
		if(this.origin === ZOTERO_CONFIG.BOOKMARKLET_ORIGIN ||
				this.origin === ZOTERO_CONFIG.HTTP_BOOKMARKLET_ORIGIN) {
			response += "Access-Control-Allow-Origin: "+this.origin+"\r\n";
			response += "Access-Control-Allow-Methods: POST, GET, OPTIONS\r\n";
			response += "Access-Control-Allow-Headers: Content-Type,X-Zotero-Connector-API-Version,X-Zotero-Version\r\n";
		}
	}
	
	if(contentType) {
		response += "Content-Type: "+contentType+"\r\n";
	}
	
	if(body) {
		response += "\r\n"+body;
	} else {
		response += "Content-Length: 0\r\n\r\n";
	}
	
	return response;
}

/**
 * Generates a response based on calling the function associated with the endpoint
 */
Zotero.Server.DataListener.prototype._processEndpoint = Zotero.Promise.coroutine(function* (method, postData) {
	try {
		var endpoint = new this.endpoint;
		
		// Check that endpoint supports method
		if(endpoint.supportedMethods && endpoint.supportedMethods.indexOf(method) === -1) {
			this._requestFinished(this._generateResponse(400, "text/plain", "Endpoint does not support method\n"));
			return;
		}
		
		// Check that endpoint supports bookmarklet
		if(this.origin) {
			var isBookmarklet = this.origin === "https://www.zotero.org" || this.origin === "http://www.zotero.org";
			// Disallow bookmarklet origins to access endpoints without permitBookmarklet
			// set. We allow other origins to access these endpoints because they have to 
			// be privileged to avoid being blocked by our headers.
			if(isBookmarklet && !endpoint.permitBookmarklet) {
				this._requestFinished(this._generateResponse(403, "text/plain", "Access forbidden to bookmarklet\n"));
				return;
			}
		}
		
		var decodedData = null;
		if(postData && this.contentType) {
			// check that endpoint supports contentType
			var supportedDataTypes = endpoint.supportedDataTypes;
			if(supportedDataTypes && supportedDataTypes != '*' 
				&& supportedDataTypes.indexOf(this.contentType) === -1) {
				
				this._requestFinished(this._generateResponse(400, "text/plain", "Endpoint does not support content-type\n"));
				return;
			}
			
			// decode content-type post data
			if(this.contentType === "application/json") {
				try {
					decodedData = JSON.parse(postData);
				} catch(e) {
					this._requestFinished(this._generateResponse(400, "text/plain", "Invalid JSON provided\n"));
					return;
				}
			} else if(this.contentType === "application/x-www-form-urlencoded") {				
				decodedData = Zotero.Server.decodeQueryString(postData);
			} else if(this.contentType === "multipart/form-data") {
				let boundary = /boundary=([^\s]*)/i.exec(this.header);
				if (!boundary) {
					return this._requestFinished(this._generateResponse(400, "text/plain", "Invalid multipart/form-data provided\n"));
				}
				boundary = '--' + boundary[1];
				try {
					decodedData = this._decodeMultipartData(postData, boundary);
				} catch(e) {
					return this._requestFinished(this._generateResponse(400, "text/plain", "Invalid multipart/form-data provided\n"));
				}
			} else {
				decodedData = postData;
			}
		}
		
		// set up response callback
		var me = this;
		var sendResponseCallback = function(code, contentType, arg) {
			me._requestFinished(me._generateResponse(code, contentType, arg));
		}
		
		// Pass to endpoint
		//
		// Single-parameter endpoint
		//   - Takes an object with 'method', 'pathname', 'query', 'headers', and 'data'
		//   - Returns a status code, an array containing [statusCode, contentType, body],
		//     or a promise for either
		if (endpoint.init.length === 1
				// Return value from Zotero.Promise.coroutine()
				|| endpoint.init.length === 0) {
			let headers = {};
			let headerLines = this.header.trim().split(/\r\n/);
			for (let line of headerLines) {
				line = line.trim();
				let pos = line.indexOf(':');
				if (pos == -1) {
					continue;
				}
				let k = line.substr(0, pos);
				let v = line.substr(pos + 1).trim();
				headers[k] = v;
			}
			
			let maybePromise = endpoint.init({
				method,
				pathname: this.pathname,
				query: this.query ? Zotero.Server.decodeQueryString(this.query.substr(1)) : {},
				headers,
				data: decodedData
			});
			let result;
			if (maybePromise.then) {
				result = yield maybePromise;
			}
			else {
				result = maybePromise;
			}
			if (Number.isInteger(result)) {
				sendResponseCallback(result);
			}
			else {
				sendResponseCallback(...result);
			}
		}
		// Two-parameter endpoint takes data and a callback
		else if (endpoint.init.length === 2) {
			endpoint.init(decodedData, sendResponseCallback);
		}
		// Three-parameter endpoint takes a URL, data, and a callback
		else {
			const uaRe = /[\r\n]User-Agent: +([^\r\n]+)/i;
			var m = uaRe.exec(this.header);
			var url = {
				"pathname":this.pathname,
				"query":this.query ? Zotero.Server.decodeQueryString(this.query.substr(1)) : {},
				"userAgent":m && m[1]
			};
			endpoint.init(url, decodedData, sendResponseCallback);
		}
	} catch(e) {
		Zotero.debug(e);
		this._requestFinished(this._generateResponse(500), "text/plain", "An error occurred\n");
		throw e;
	}
});

/*
 * returns HTTP data from a request
 */
Zotero.Server.DataListener.prototype._requestFinished = function(response) {
	if(this._responseSent) {
		Zotero.debug("Request already finished; not sending another response");
		return;
	}
	this._responseSent = true;
	
	// close input stream
	this.iStream.close();
	
	// open UTF-8 converter for output stream	
	var intlStream = Components.classes["@mozilla.org/intl/converter-output-stream;1"]
							   .createInstance(Components.interfaces.nsIConverterOutputStream);
	
	// write
	try {
		intlStream.init(this.oStream, "UTF-8", 1024, "?".charCodeAt(0));
		
		// write response
		Zotero.debug(response, 5);
		intlStream.writeString(response);
	} finally {	
		intlStream.close();
	}
}

Zotero.Server.DataListener.prototype._decodeMultipartData = function(data, boundary) {
	var contentDispositionRe = /^Content-Disposition:\s*(.*)$/i;
	var results = [];
	data = data.split(boundary);
	// Ignore pre first boundary and post last boundary
	data = data.slice(1, data.length-1);
	for (let field of data) {
		let fieldData = {};
		field = field.trim();
		// Split header and body
		let unixHeaderBoundary = field.indexOf("\n\n");
		let windowsHeaderBoundary = field.indexOf("\r\n\r\n");
		if (unixHeaderBoundary < windowsHeaderBoundary && unixHeaderBoundary != -1) {
			fieldData.header = field.slice(0, unixHeaderBoundary);
			fieldData.body = field.slice(unixHeaderBoundary+2);
		} else if (windowsHeaderBoundary != -1) {
			fieldData.header = field.slice(0, windowsHeaderBoundary);
			fieldData.body = field.slice(windowsHeaderBoundary+4);
		} else {
			throw new Error('Malformed multipart/form-data body');
		}
		
		let contentDisposition = contentDispositionRe.exec(fieldData.header);
		if (contentDisposition) {
			for (let nameVal of contentDisposition[1].split(';')) {
				nameVal.split('=');
				fieldData[nameVal[0]] = nameVal.length > 1 ? nameVal[1] : null;
			}
		}
		results.push(fieldData);
	}
	return results;
};


/**
 * Endpoints for the HTTP server
 *
 * Each endpoint should take the form of an object. The init() method of this object will be passed:
 *     method - the method of the request ("GET" or "POST")
 *     data - the query string (for a "GET" request) or POST data (for a "POST" request)
 *     sendResponseCallback - a function to send a response to the HTTP request. This can be passed
 *                            a response code alone (e.g., sendResponseCallback(404)) or a response
 *                            code, MIME type, and response body
 *                            (e.g., sendResponseCallback(200, "text/plain", "Hello World!"))
 *
 * See connector/server_connector.js for examples
 */
Zotero.Server.Endpoints = {}