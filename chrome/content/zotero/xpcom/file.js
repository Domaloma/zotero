/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2009 Center for History and New Media
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

/**
 * Functions for reading files
 * @namespace
 */
Zotero.File = new function(){
	Components.utils.import("resource://gre/modules/NetUtil.jsm");
	Components.utils.import("resource://gre/modules/FileUtils.jsm");
	
	this.getExtension = getExtension;
	this.getClosestDirectory = getClosestDirectory;
	this.getContentsFromURL = getContentsFromURL;
	this.putContents = putContents;
	this.getValidFileName = getValidFileName;
	this.truncateFileName = truncateFileName;
	this.getCharsetFromFile = getCharsetFromFile;
	this.addCharsetListener = addCharsetListener;
	
	
	this.pathToFile = function (pathOrFile) {
		if (typeof pathOrFile == 'string') {
			return new FileUtils.File(pathOrFile);
		}
		else if (pathOrFile instanceof Ci.nsIFile) {
			return pathOrFile;
		}
		throw new Error("Unexpected value '" + pathOrFile + "'");
	}
	
	
	this.pathToFileURI = function (path) {
		var file = new FileUtils.File(path);
		var ios = Components.classes["@mozilla.org/network/io-service;1"]
			.getService(Components.interfaces.nsIIOService);
		return ios.newFileURI(file).spec;
	}
	
	
	/**
	 * Encode special characters in file paths that might cause problems,
	 *  like # (but preserve slashes or colons)
	 *
	 * @param {String} path File path
	 * @return {String} Encoded file path
	 */
	this.encodeFilePath = function(path) {
		var parts = path.split(/([\\\/:]+)/);
		// Every other item is the separator
		for (var i=0, n=parts.length; i<n; i+=2) {
			parts[i] = encodeURIComponent(parts[i]);
		}
		return parts.join('');
	}
	
	function getExtension(file){
		file = this.pathToFile(file);
		var pos = file.leafName.lastIndexOf('.');
		return pos==-1 ? '' : file.leafName.substr(pos+1);
	}
	
	
	/*
	 * Traverses up the filesystem from a file until it finds an existing
	 *  directory, or false if it hits the root
	 */
	function getClosestDirectory(file) {
		var dir = file.parent;
		
		while (dir && !dir.exists()) {
			var dir = dir.parent;
		}
		
		if (dir && dir.exists()) {
			return dir;
		}
		return false;
	}
	
	
	/**
	 * Get the first 200 bytes of a source as a string (multibyte-safe)
	 *
	 * @param {nsIURI|nsIFile|string spec|nsIChannel|nsIInputStream} source - The source to read
	 * @return {Promise}
	 */
	this.getSample = function (file) {
		var bytes = 200;
		return this.getContentsAsync(file, null, bytes)
		.catch(function (e) {
			if (e.name == 'NS_ERROR_ILLEGAL_INPUT') {
				Zotero.debug("Falling back to raw bytes");
				return this.getBinaryContentsAsync(file, bytes);
			}
			throw e;
		}.bind(this));
	}
	
	
	/**
	 * Get contents of a binary file
	 */
	this.getBinaryContents = function(file) {
		var iStream = Components.classes["@mozilla.org/network/file-input-stream;1"]
					 .createInstance(Components.interfaces.nsIFileInputStream);
		iStream.init(file, 0x01, 0664, 0);
		var bStream = Components.classes["@mozilla.org/binaryinputstream;1"]
					 .createInstance(Components.interfaces.nsIBinaryInputStream);
		bStream.setInputStream(iStream);
		var string = bStream.readBytes(file.fileSize);
		iStream.close();
		return string;
	}
	
	
	/**
	 * Get the contents of a file or input stream
	 * @param {nsIFile|nsIInputStream|string path} file The file to read
	 * @param {String} [charset] The character set; defaults to UTF-8
	 * @param {Integer} [maxLength] The maximum number of bytes to read
	 * @return {String} The contents of the file
	 * @deprecated Use {@link Zotero.File.getContentsAsync} when possible
	 */
	this.getContents = function (file, charset, maxLength){
		var fis;
		
		if (typeof file == 'string') {
			file = new FileUtils.File(file);
		}
		
		if(file instanceof Components.interfaces.nsIInputStream) {
			fis = file;
		} else if(file instanceof Components.interfaces.nsIFile) {
			fis = Components.classes["@mozilla.org/network/file-input-stream;1"].
				createInstance(Components.interfaces.nsIFileInputStream);
			fis.init(file, 0x01, 0664, 0);
		} else {
			throw new Error("File is not an nsIInputStream or nsIFile");
		}
		
		if (charset) {
			charset = Zotero.CharacterSets.toLabel(charset, true)
		}
		charset = charset || "UTF-8";
		
		var blockSize = maxLength ? Math.min(maxLength, 524288) : 524288;
		
		const replacementChar
			= Components.interfaces.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER;
		var is = Components.classes["@mozilla.org/intl/converter-input-stream;1"]
			.createInstance(Components.interfaces.nsIConverterInputStream);
		is.init(fis, charset, blockSize, replacementChar);
		var chars = 0;
		
		var contents = "", str = {};
		while (is.readString(blockSize, str) !== 0) {
			if (maxLength) {
				var strLen = str.value.length;
				if ((chars + strLen) > maxLength) {
					var remainder = maxLength - chars;
					contents += str.value.slice(0, remainder);
					break;
				}
				chars += strLen;
			}
			
			contents += str.value;
		}
		
		is.close();
		
		return contents;
	};
	
	
	/**
	 * Get the contents of a text source asynchronously
	 *
	 * @param {nsIURI|nsIFile|string spec|string path|nsIChannel|nsIInputStream} source The source to read
	 * @param {String} [charset] The character set; defaults to UTF-8
	 * @param {Integer} [maxLength] Maximum length to fetch, in bytes
	 * @return {Promise} A promise that is resolved with the contents of the file
	 */
	this.getContentsAsync = function (source, charset, maxLength) {
		Zotero.debug("Getting contents of "
			+ (source instanceof Components.interfaces.nsIFile
				? source.path
				: (source instanceof Components.interfaces.nsIInputStream ? "input stream" : source)));
		
		// If path is given, convert to file:// URL
		if (typeof source == 'string' && !source.match(/^file:/)) {
			source = 'file://' + source;
		}
		
		var options = {
			charset: charset ? charset : "UTF-8",
			replacement: 65533
		};
		
		var deferred = Zotero.Promise.defer();
		NetUtil.asyncFetch(source, function(inputStream, status) {
			if (!Components.isSuccessCode(status)) {
				deferred.reject(new Components.Exception("File read operation failed", status));
				return;
			}
			
			try {
				try {
					var bytesToFetch = inputStream.available();
				}
				catch (e) {
					// The stream is closed automatically when end-of-file is reached,
					// so this throws for empty files
					if (e.name == "NS_BASE_STREAM_CLOSED") {
						deferred.resolve("");
					}
				}
				
				if (maxLength && maxLength < bytesToFetch) {
					bytesToFetch = maxLength;
				}
				
				if (bytesToFetch == 0) {
					deferred.resolve("");
					return;
				}
				
				deferred.resolve(
					NetUtil.readInputStreamToString(
						inputStream,
						bytesToFetch,
						options
					)
				);
			}
			catch (e) {
				deferred.reject(e);
			}
		});
		return deferred.promise;
	};
	
	
	/**
	 * Get the contents of a binary source asynchronously
	 *
	 * @param {nsIURI|nsIFile|string spec|nsIChannel|nsIInputStream} source The source to read
	 * @param {Integer} [maxLength] Maximum length to fetch, in bytes (unimplemented)
	 * @return {Promise} A promise that is resolved with the contents of the source
	 */
	this.getBinaryContentsAsync = function (source, maxLength) {
		if (typeof source == 'string') {
			source = this.pathToFile(source);
		}
		var deferred = Zotero.Promise.defer();
		NetUtil.asyncFetch(source, function(inputStream, status) {
			if (!Components.isSuccessCode(status)) {
				deferred.reject(new Components.Exception("Source read operation failed", status));
				return;
			}
			try {
				var availableBytes = inputStream.available();
				deferred.resolve(
					NetUtil.readInputStreamToString(
						inputStream,
						maxLength ? Math.min(maxLength, availableBytes) : availableBytes
					)
				);
			}
			catch (e) {
				deferred.reject(e);
			}
		});
		return deferred.promise;
	}
	
	
	/*
	 * Return the contents of a URL as a string
	 *
	 * Runs synchronously, so should only be run on local (e.g. chrome) URLs
	 */
	function getContentsFromURL(url) {
		var xmlhttp = Components.classes["@mozilla.org/xmlextras/xmlhttprequest;1"]
						.createInstance();
		xmlhttp.open('GET', url, false);
		xmlhttp.overrideMimeType("text/plain");
		xmlhttp.send(null);
		return xmlhttp.responseText;
	}
	
	
	/*
	 * Return a promise for the contents of a URL as a string
	 */
	this.getContentsFromURLAsync = function (url) {
		return Zotero.HTTP.request("GET", url, { responseType: "text" })
		.then(function (xmlhttp) {
			return xmlhttp.response;
		});
	}
	
	
	/*
	 * Write string to a file, overwriting existing file if necessary
	 */
	function putContents(file, str) {
		if (file.exists()) {
			file.remove(null);
		}
		var fos = Components.classes["@mozilla.org/network/file-output-stream;1"].
				createInstance(Components.interfaces.nsIFileOutputStream);
		fos.init(file, 0x02 | 0x08 | 0x20, 0664, 0);  // write, create, truncate
		
		var os = Components.classes["@mozilla.org/intl/converter-output-stream;1"]
						   .createInstance(Components.interfaces.nsIConverterOutputStream);
		os.init(fos, "UTF-8", 4096, "?".charCodeAt(0));
		os.writeString(str);
		os.close();
		
		fos.close();
	}
	
	/**
	 * Write data to a file asynchronously
	 *
	 * @param {String|nsIFile} - String path or nsIFile to write to
	 * @param {String|nsIInputStream} data - The string or nsIInputStream to write to the file
	 * @param {String} [charset] - The character set; defaults to UTF-8
	 * @return {Promise} - A promise that is resolved when the file has been written
	 */
	this.putContentsAsync = function (path, data, charset) {
		if (path instanceof Ci.nsIFile) {
			path = path.path;
		}
		
		if (typeof data == 'string') {
			return Zotero.Promise.resolve(OS.File.writeAtomic(
				path,
				data,
				{
					// Note: this will fail on Windows if the temp
					// directory is on a different drive from
					// destination path
					tmpPath: OS.Path.join(
						Zotero.getTempDirectory().path,
						OS.Path.basename(path) + ".tmp"
					),
					encoding: charset ? charset.toLowerCase() : 'utf-8'
				}
			));
		}
		
		var deferred = Zotero.Promise.defer();
		var os = FileUtils.openSafeFileOutputStream(new FileUtils.File(path));
		NetUtil.asyncCopy(data, os, function(inputStream, status) {
			if (!Components.isSuccessCode(status)) {
				deferred.reject(new Components.Exception("File write operation failed", status));
				return;
			}
			deferred.resolve();
		});
		return deferred.promise;
	};
	
	
	this.download = Zotero.Promise.coroutine(function* (uri, path) {
		Zotero.debug("Saving " + (uri.spec ? uri.spec : uri)
			+ " to " + (path.path ? path.path : path));			
		
		var deferred = Zotero.Promise.defer();
		NetUtil.asyncFetch(uri, function (is, status, request) {
			if (!Components.isSuccessCode(status)) {
				Zotero.logError(status);
				deferred.reject(new Error("Download failed with status " + status));
				return;
			}
			deferred.resolve(is);
		});
		var is = yield deferred.promise;
		yield Zotero.File.putContentsAsync(path, is);
	});
	
	
	/**
	 * Delete a file if it exists, asynchronously
	 *
	 * @return {Promise<Boolean>} A promise for TRUE if file was deleted, FALSE if missing
	 */
	this.removeIfExists = function (path) {
		return Zotero.Promise.resolve(OS.File.remove(path))
		.return(true)
		.catch(function (e) {
			if (e instanceof OS.File.Error && e.becauseNoSuchFile) {
				return false;
			}
			Zotero.debug(path, 1);
			throw e;
		});
	}
	
	
	/**
	 * Run a generator with an OS.File.DirectoryIterator, closing the
	 * iterator when done
	 *
	 * The DirectoryInterator is passed as the first parameter to the generator.
	 *
	 * Zotero.File.iterateDirectory(path, function* (iterator) {
	 *    while (true) {
	 *        var entry = yield iterator.next();
	 *        [...]
	 *    }
	 * })
	 *
	 * @return {Promise}
	 */
	this.iterateDirectory = function (path, generator) {
		var iterator = new OS.File.DirectoryIterator(path);
		return Zotero.Promise.coroutine(generator)(iterator)
		.catch(function (e) {
			if (e != StopIteration) {
				throw e;
			}
		})
		.finally(function () {
			iterator.close();
		});
	}
	
	
	/**
	 * Generate a data: URI from an nsIFile
	 *
	 * From https://developer.mozilla.org/en-US/docs/data_URIs
	 */
	this.generateDataURI = function (file) {
		var contentType = Components.classes["@mozilla.org/mime;1"]
			.getService(Components.interfaces.nsIMIMEService)
			.getTypeFromFile(file);
		var inputStream = Components.classes["@mozilla.org/network/file-input-stream;1"]
			.createInstance(Components.interfaces.nsIFileInputStream);
		inputStream.init(file, 0x01, 0600, 0);
		var stream = Components.classes["@mozilla.org/binaryinputstream;1"]
			.createInstance(Components.interfaces.nsIBinaryInputStream);
		stream.setInputStream(inputStream);
		var encoded = btoa(stream.readBytes(stream.available()));
		return "data:" + contentType + ";base64," + encoded;
	}
	
	
	this.createShortened = function (file, type, mode, maxBytes) {
		file = this.pathToFile(file);
		
		if (!maxBytes) {
			maxBytes = 255;
		}
		
		// Limit should be 255, but leave room for unique numbering if necessary
		var padding = 3;
		
		while (true) {
			var newLength = maxBytes - padding;
			
			try {
				file.create(type, mode);
			}
			catch (e) {
				let pathError = false;
				
				let pathByteLength = Zotero.Utilities.Internal.byteLength(file.path);
				let fileNameByteLength = Zotero.Utilities.Internal.byteLength(file.leafName);
				
				// Windows API only allows paths of 260 characters
				//
				// I think this should be >260 but we had a report of an error with exactly
				// 260 chars: https://forums.zotero.org/discussion/41410
				if (e.name == "NS_ERROR_FILE_NOT_FOUND" && pathByteLength >= 260) {
					Zotero.debug("Path is " + file.path);
					pathError = true;
				}
				// ext3/ext4/HFS+ have a filename length limit of ~254 bytes
				else if ((e.name == "NS_ERROR_FAILURE" || e.name == "NS_ERROR_FILE_NAME_TOO_LONG")
						&& (fileNameByteLength >= 254 || (Zotero.isLinux && fileNameByteLength > 143))) {
					Zotero.debug("Filename is '" + file.leafName + "'");
				}
				else {
					Zotero.debug("Path is " + file.path);
					throw e;
				}
				
				// Preserve extension
				var matches = file.leafName.match(/.+(\.[a-z0-9]{0,20})$/i);
				var ext = matches ? matches[1] : "";
				
				if (pathError) {
					let pathLength = pathByteLength - fileNameByteLength;
					newLength -= pathLength;
					
					// Make sure there's a least 1 character of the basename left over
					if (newLength - ext.length < 1) {
						throw new Error("Path is too long");
					}
				}
				
				// Shorten the filename
				//
				// Shortened file could already exist if there was another file with a
				// similar name that was also longer than the limit, so we do this in a
				// loop, adding numbers if necessary
				var uniqueFile = file.clone();
				var step = 0;
				while (step < 100) {
					let newBaseName = uniqueFile.leafName.substr(0, newLength - ext.length);
					if (step == 0) {
						var newName = newBaseName + ext;
					}
					else {
						var newName = newBaseName + "-" + step + ext;
					}
					
					// Check actual byte length, and shorten more if necessary
					if (Zotero.Utilities.Internal.byteLength(newName) > maxBytes) {
						step = 0;
						newLength--;
						continue;
					}
					
					uniqueFile.leafName = newName;
					if (!uniqueFile.exists()) {
						break;
					}
					
					step++;
				}
				
				var msg = "Shortening filename to '" + newName + "'";
				Zotero.debug(msg, 2);
				Zotero.log(msg, 'warning');
				
				try {
					uniqueFile.create(Components.interfaces.nsIFile.type, mode);
				}
				catch (e) {
					// On Linux, try 143, which is the max filename length with eCryptfs
					if (e.name == "NS_ERROR_FILE_NAME_TOO_LONG" && Zotero.isLinux && uniqueFile.leafName.length > 143) {
						Zotero.debug("Trying shorter filename in case of filesystem encryption", 2);
						maxBytes = 143;
						continue;
					}
					else {
						throw e;
					}
				}
				
				file.leafName = uniqueFile.leafName;
			}
			break;
		}
		
		return file.leafName;
	}
	
	
	this.copyToUnique = function (file, newFile) {
		file = this.pathToFile(file);
		newFile = this.pathToFile(newFile);
		
		newFile.createUnique(Components.interfaces.nsIFile.NORMAL_FILE_TYPE, 0644);
		var newName = newFile.leafName;
		newFile.remove(null);
		
		// Copy file to unique name
		file.copyToFollowingLinks(newFile.parent, newName);
		return newFile;
	}
	
	
	/**
	 * Copies all files from dir into newDir
	 *
	 * @param {String|nsIFile} source - Source directory
	 * @param {String|nsIFile} target - Target directory
	 */
	this.copyDirectory = Zotero.Promise.coroutine(function* (source, target) {
		if (source instanceof Ci.nsIFile) source = source.path;
		if (target instanceof Ci.nsIFile) target = target.path;
		
		yield OS.File.makeDir(target, {
			ignoreExisting: true,
			unixMode: 0o755
		});
		
		return this.iterateDirectory(source, function* (iterator) {
			while (true) {
				let entry = yield iterator.next();
				yield OS.File.copy(entry.path, OS.Path.join(target, entry.name));
			}
		})
	});
	
	
	this.createDirectoryIfMissing = function (dir) {
		if (!dir.exists() || !dir.isDirectory()) {
			if (dir.exists() && !dir.isDirectory()) {
				dir.remove(null);
			}
			dir.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0755);
		}
	}
	
	
	this.createDirectoryIfMissingAsync = function (path) {
		return Zotero.Promise.resolve(
			OS.File.makeDir(
				path,
				{
					ignoreExisting: true,
					unixMode: 0755
				}
			)
		);
	}
	
	
	/**
	 * Check whether a directory is an ancestor directory of another directory/file
	 */
	this.directoryContains = function (dir, file) {
		if (typeof dir != 'string') throw new Error("dir must be a string");
		if (typeof file != 'string') throw new Error("file must be a string");
		
		dir = OS.Path.normalize(dir);
		file = OS.Path.normalize(file);
		
		return file.startsWith(dir);
	};
	
	
	/**
	 * @param {String} dirPath - Directory containing files to add to ZIP
	 * @param {String} zipPath - ZIP file to create
	 * @param {nsIRequestObserver} [observer]
	 * @return {Promise}
	 */
	this.zipDirectory = Zotero.Promise.coroutine(function* (dirPath, zipPath, observer) {
		var zw = Components.classes["@mozilla.org/zipwriter;1"]
			.createInstance(Components.interfaces.nsIZipWriter);
		zw.open(this.pathToFile(zipPath), 0x04 | 0x08 | 0x20); // open rw, create, truncate
		var entries = yield _addZipEntries(dirPath, dirPath, zw);
		if (entries.length == 0) {
			Zotero.debug('No files to add -- removing ZIP file');
			zw.close();
			yield OS.File.remove(zipPath);
			return false;
		}
		
		Zotero.debug(`Creating ${OS.Path.basename(zipPath)} with ${entries.length} file(s)`);
		
		var context = {
			zipWriter: zw,
			entries
		};
		
		var deferred = Zotero.Promise.defer();
		zw.processQueue(
			{
				onStartRequest: function (request, ctx) {
					try {
						if (observer && observer.onStartRequest) {
							observer.onStartRequest(request, context);
						}
					}
					catch (e) {
						deferred.reject(e);
					}
				},
				onStopRequest: function (request, ctx, status) {
					try {
						if (observer && observer.onStopRequest) {
							observer.onStopRequest(request, context, status);
						}
					}
					catch (e) {
						deferred.reject(e);
						return;
					}
					finally {
						zw.close();
					}
					deferred.resolve(true);
				}
			},
			{}
		);
		return deferred.promise;
	});
	
	
	var _addZipEntries = Zotero.Promise.coroutine(function* (rootPath, path, zipWriter) {
		var entries = [];
		let iterator;
		try {
			iterator = new OS.File.DirectoryIterator(path);
			yield iterator.forEach(Zotero.Promise.coroutine(function* (entry) {
				if (entry.isSymLink) {
					Zotero.debug("Skipping symlink " + entry.name);
					return;
				}
				if (entry.isDir) {
					entries.concat(yield _addZipEntries(rootPath, entry.path, zipWriter));
					return;
				}
				if (entry.name.startsWith('.')) {
					Zotero.debug('Skipping file ' + entry.name);
					return;
				}
				
				zipWriter.addEntryFile(
					// Add relative path
					entry.path.substr(rootPath.length + 1),
					Components.interfaces.nsIZipWriter.COMPRESSION_DEFAULT,
					Zotero.File.pathToFile(entry.path),
					true
				);
				entries.push({
					name: entry.name,
					path: entry.path
				});
			}));
		}
		finally {
			iterator.close();
		}
		return entries;
	});
	
	
	/**
	 * Strip potentially invalid characters
	 *
	 * See http://en.wikipedia.org/wiki/Filename#Reserved_characters_and_words
	 *
	 * @param	{String}	fileName
	 * @param	{Boolean}	[skipXML=false]		Don't strip characters invalid in XML
	 */
	function getValidFileName(fileName, skipXML) {
		// TODO: use space instead, and figure out what's doing extra
		// URL encode when saving attachments that trigger this
		fileName = fileName.replace(/[\/\\\?\*:|"<>]/g, '');
		// Replace newlines and tabs (which shouldn't be in the string in the first place) with spaces
		fileName = fileName.replace(/[\r\n\t]+/g, ' ');
		// Replace various thin spaces
		fileName = fileName.replace(/[\u2000-\u200A]/g, ' ');
		// Replace zero-width spaces
		fileName = fileName.replace(/[\u200B-\u200E]/g, '');
		if (!skipXML) {
			// Strip characters not valid in XML, since they won't sync and they're probably unwanted
			fileName = fileName.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/g, '');
			
			// Normalize to NFC
			fileName = fileName.normalize();
		}
		// Don't allow hidden files
		fileName = fileName.replace(/^\./, '');
		// Don't allow blank or illegal filenames
		if (!fileName || fileName == '.' || fileName == '..') {
			fileName = '_';
		}
		return fileName;
	}
	
	/**
	 * Truncate a filename (excluding the extension) to the given total length
	 * If the "extension" is longer than 20 characters,
	 * it is treated as part of the file name
	 */
	function truncateFileName(fileName, maxLength) {
		if(!fileName || (fileName + '').length <= maxLength) return fileName;

		var parts = (fileName + '').split(/\.(?=[^\.]+$)/);
		var fn = parts[0];
		var ext = parts[1];
		//if the file starts with a period , use the whole file
		//the whole file name might also just be a period
		if(!fn) {
			fn = '.' + (ext || '');
		}

		//treat long extensions as part of the file name
		if(ext && ext.length > 20) {
			fn += '.' + ext;
			ext = undefined;
		}

		if(ext === undefined) {	//there was no period in the whole file name
			ext = '';
		} else {
			ext = '.' + ext;
		}

		return fn.substr(0,maxLength-ext.length) + ext;
	}
	
	/*
	 * Not implemented, but it'd sure be great if it were
	 */
	function getCharsetFromByteArray(arr) {
		
	}
	
	
	/*
	 * An extraordinarily inelegant way of getting the character set of a
	 * text file using a hidden browser
	 *
	 * I'm quite sure there's a better way
	 *
	 * Note: This is for text files -- don't run on other files
	 *
	 * 'callback' is the function to pass the charset (and, if provided, 'args')
	 * to after detection is complete
	 */
	function getCharsetFromFile(file, mimeType, callback, args){
		if (!file || !file.exists()){
			callback(false, args);
			return;
		}
		
		if (mimeType.substr(0, 5) != 'text/' ||
				!Zotero.MIME.hasInternalHandler(mimeType, this.getExtension(file))) {
			callback(false, args);
			return;
		}
		
		var browser = Zotero.Browser.createHiddenBrowser();
		
		var url = Components.classes["@mozilla.org/network/protocol;1?name=file"]
				.getService(Components.interfaces.nsIFileProtocolHandler)
				.getURLSpecFromFile(file);
		
		this.addCharsetListener(browser, function (charset, args) {
			callback(charset, args);
			Zotero.Browser.deleteHiddenBrowser(browser);
		}, args);
		
		browser.loadURI(url);
	}
	
	
	/*
	 * Attach a load listener to a browser object to perform charset detection
	 *
	 * We make sure the universal character set detector is set to the
	 * universal_charset_detector (temporarily changing it if not--shhhh)
	 *
	 * 'callback' is the function to pass the charset (and, if provided, 'args')
	 * to after detection is complete
	 */
	function addCharsetListener(browser, callback, args){
		var prefService = Components.classes["@mozilla.org/preferences-service;1"]
							.getService(Components.interfaces.nsIPrefBranch);
		var oldPref = prefService.getCharPref('intl.charset.detector');
		var newPref = 'universal_charset_detector';
		//Zotero.debug("Default character detector is " + (oldPref ? oldPref : '(none)'));
		
		if (oldPref != newPref){
			//Zotero.debug('Setting character detector to universal_charset_detector');
			prefService.setCharPref('intl.charset.detector', 'universal_charset_detector');
		}
		
		var onpageshow = function(){
			// ignore spurious about:blank loads
			if(browser.contentDocument.location.href == "about:blank") return;

			browser.removeEventListener("pageshow", onpageshow, false);
			
			var charset = browser.contentDocument.characterSet;
			Zotero.debug("Detected character set '" + charset + "'");
			
			//Zotero.debug('Resetting character detector to ' + (oldPref ? oldPref : '(none)'));
			prefService.setCharPref('intl.charset.detector', oldPref);
			
			callback(charset, args);
		};
		
		browser.addEventListener("pageshow", onpageshow, false);
	}
	
	
	this.checkFileAccessError = function (e, file, operation) {
		file = this.pathToFile(file);
		
		var str = 'file.accessError.';
		if (file) {
			str += 'theFile'
		}
		else {
			str += 'aFile'
		}
		str += 'CannotBe';
		
		switch (operation) {
			case 'create':
				str += 'Created';
				break;
				
			case 'delete':
				str += 'Deleted';
				break;
				
			default:
				str += 'Updated';
		}
		str = Zotero.getString(str, file.path ? file.path : undefined);
		
		Zotero.debug(file.path);
		Zotero.debug(e, 1);
		Components.utils.reportError(e);
		
		if (e.name == 'NS_ERROR_FILE_ACCESS_DENIED' || e.name == 'NS_ERROR_FILE_IS_LOCKED'
				// These show up on some Windows systems
				|| e.name == 'NS_ERROR_FAILURE' || e.name == 'NS_ERROR_FILE_NOT_FOUND') {
			str = str + " " + Zotero.getString('file.accessError.cannotBe') + " " + opWord + ".";
			var checkFileWindows = Zotero.getString('file.accessError.message.windows');
			var checkFileOther = Zotero.getString('file.accessError.message.other');
			var msg = str + "\n\n"
					+ (Zotero.isWin ? checkFileWindows : checkFileOther)
					+ "\n\n"
					+ Zotero.getString('file.accessError.restart');
			
			var e = new Zotero.Error(
				msg,
				0,
				{
					dialogButtonText: Zotero.getString('file.accessError.showParentDir'),
					dialogButtonCallback: function () {
						try {
							file.parent.QueryInterface(Components.interfaces.nsILocalFile);
							file.parent.reveal();
						}
						// Unsupported on some platforms
						catch (e2) {
							Zotero.launchFile(file.parent);
						}
					}
				}
			);
		}
		
		throw (e);
	}
	
	
	this.checkPathAccessError = function (e, path, operation) {
		var str = 'file.accessError.';
		if (path) {
			str += 'theFile'
		}
		else {
			str += 'aFile'
		}
		str += 'CannotBe';
		
		switch (operation) {
			case 'create':
				str += 'Created';
				break;
				
			case 'delete':
				str += 'Deleted';
				break;
				
			default:
				str += 'Updated';
		}
		str = Zotero.getString(str, path ? path : undefined);
		
		Zotero.debug(path);
		Zotero.debug(e, 1);
		Components.utils.reportError(e);
		
		// TODO: Check for specific errors?
		if (e instanceof OS.File.Error) {
			let checkFileWindows = Zotero.getString('file.accessError.message.windows');
			let checkFileOther = Zotero.getString('file.accessError.message.other');
			var msg = str + "\n\n"
					+ (Zotero.isWin ? checkFileWindows : checkFileOther)
					+ "\n\n"
					+ Zotero.getString('file.accessError.restart');
			
			var e = new Zotero.Error(
				msg,
				0,
				{
					dialogButtonText: Zotero.getString('file.accessError.showParentDir'),
					dialogButtonCallback: function () {
						try {
							file.parent.QueryInterface(Components.interfaces.nsILocalFile);
							file.parent.reveal();
						}
						// Unsupported on some platforms
						catch (e2) {
							Zotero.launchFile(file.parent);
						}
					}
				}
			);
		}
		
		throw e;
	}


	this.isDropboxDirectory = function(path) {
		return path.toLowerCase().indexOf('dropbox') != -1;
	}
}
