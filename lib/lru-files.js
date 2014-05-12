#!/usr/bin/env node

/* require node modules */
var fs = require("fs");
var path = require("path");
var stream = require("stream");

/* require npm modules */
var mkdirp = require("mkdirp");
var dur = require("dur");

/* application root */
var __root = path.dirname(process.mainModule.filename);

function lrufiles(options){
	
	/* always return a fresh instance */
	if (!(this instanceof lrufiles)) return new lrufiles(options);
	
	/* variable for this instance */
	var l = this;
	
	/* options of this instance */
	this.options = {};
	
	/* debugging glag */
	this.options.debug = ((!options.hasOwnProperty("debug") || options.debug !== true) ? false : true);
	
	/* determine cache directory */
	if (!options.hasOwnProperty("dir") || typeof options.dir !== "string") options.dir = "cache";
	this.options.dir = path.resolve(__root, options.dir);
		
	/* determine maximal total number of files */
	if (!options.hasOwnProperty("files") || typeof options.files !== "number") options.files = 0;
	this.options.files = options.files;
	
	/* determine maximal total file size */
	if (!options.hasOwnProperty("size")) options.size = 0;
	if (typeof options.size === "string") options.size = _filesize(options.size);
	if (typeof options.size !== "number") options.size = 0;
	this.options.size = options.size;

	/* determine maximal file age */
	if (!options.hasOwnProperty("age")) options.age = 0;
	if (typeof options.age === "string") options.age = dur(options.age);
	if (typeof options.age !== "number") options.age = 0;
	this.options.age = options.age;

	/* determine cleanup interval */
	if (!options.hasOwnProperty("check")) options.check = 0;
	if (typeof options.check === "string") options.check = dur(options.check);
	if (typeof options.check !== "number") options.check = 0;
	if (options.check > 0 && options.check < 10000) options.check = 10000; // minimum 10 seconds
	this.options.check = options.check;

	/* start up clean timer if applicible */
	if (l.options.check > 0) {
		l.cleantimer = setInterval(function(){
			if (l.options.debug) console.error("[clean] start");
			l.clean(function(){
				if (l.options.debug) console.error("[clean] complete");
			});
		}, this.options.check);
	}

	/* make cache direcotry if not exists */
	if (!fs.existsSync(l.options.dir)) {
		try {
			mkdirp.sync(l.options.dir);
			if (l.options.debug) console.error("[cache] created cache directory", l.options.dir);
		} catch(err) {
			console.error("[cache] could not create cache directory", l.options.dir, err);
		}
	}

	return this;
	
};

/* check if a file exists */
lrufiles.prototype.check = function(filename, callback){

	var _filename = path.resolve(this.options.dir, _sanitize(filename));
	fs.exists(_filename, callback);
	
};

/* add a file */
lrufiles.prototype.add = function(filename, data, callback){
		
	var _filename = path.resolve(this.options.dir, _sanitize(filename));
	
	/* if no callback given, create a default callback with error logging */
	if (typeof callback !== "function") var callback = function(err){
		if (err && l.options.debug) console.error("[add] error", err);
	};
	
	/* make sure the direcotry exists */
	_mkdir(path.dirname(_filename), function(err){
		if (err) return callback(err);

		if ((data instanceof stream) || (data instanceof stream.Readable) || (data.readable === true)) {
		
			/* pipe stream to file */
			data.pipe(fs.createWriteStream(_filename).on("finish", function(){
				callback(null, _filename);
			}).on("error", function(err){
				callback(err);
			}));

		} else if (data instanceof Buffer) {

			/* write buffer to file */
			fs.writeFile(_filename, data, function(err){
				if (err) return callback(err);
				callback(null, _filename);
			});
		
		} else if (typeof data === "object") {

			/* serialize object and write to file */
			try { // some data can't be serialzed and this is the only way to find out
				var _data = JSON.stringify(data);
			} catch (err) {
				return callback(err)
			};
			fs.writeFile(_filename, _data, function(err){
				if (err) return callback(err);
				callback(null, _filename);
			});

		} else {

			/* write to file */
			fs.writeFile(_filename, data, function(err){
				if (err) return callback(err);
				callback(null, _filename);
			});

		};

	});
	
};

/* get a file as buffer */
lrufiles.prototype.get = function(filename, callback){
	
	var _filename = path.resolve(this.options.dir, _sanitize(filename));
	
	fs.exists(_filename, function(exists){
		if (!exists) return callback(new Error("file does not exists: "+_filename));
		fs.readFile(_filename, function(err, buffer){
			if (err) return callback(err);
			callback(null, buffer);
		});
	});
	
};

/* get a file as stream */
lrufiles.prototype.stream = function(filename, callback){
	
	var _filename = path.resolve(this.options.dir, _sanitize(filename));

	if (typeof callback === "function") {
		fs.exists(_filename, function(exists){
			if (!exists) return callback(new Error("file does not exists: "+_filename));
			callback(null, fs.createReadStream(_filename));
		});
	} else {
		return fs.createReadStream(_filename);
	}
	
};

/* empty the cache */
lrufiles.prototype.purge = function(callback){
	var l = this;
	_readdir(l.options.dir, function(err, files){
		if (err) return console.error("[purge] could not read direcotry", l.options.dir);
		files = files.map(function(item){ return item.file; });
		_unlink(files, function(){
			if (l.options.debug) console.error("[purge] deleted", files.length, "files");
			if (typeof callback === "function") callback(null, files);
		});
	});
};

/* cleanup files */
lrufiles.prototype.clean = function(callback) {
	var l = this;
	_readdir(l.options.dir, function(err, files){
		if (err) return console.error("[clean] could not read direcotry", l.options.dir);
		var unlink = [];
		files.sort(function(a,b){
			return (b.atime-a.atime);
		});
		/* check number of files */
		if (l.options.files > 0 && files.length >= l.options.files) {
			unlink = unlink.concat(files.slice(l.options.files));
			files = files.slice(0, l.options.files);
		}
		/* check maximum file age */
		if (l.options.age > 0) {
			var _files = [];
			var _maxatime = (((new Date()).getTime())-l.options.age)
			files.forEach(function(file){
				if (file.atime < _maxatime) return unlink.push(file);
				_files.push(file);
			});
			files = _files;
		}
		/* check maximum file size */
		if (l.options.size > 0) {
			var _files = [];
			var total = 0;
			files.forEach(function(file){
				// don't add to total if a file is marked for deletion, this way large files will not prevent small files from being kept.
				if ((total+file.size) > l.options.size) return unlink.push(file);
				_files.push(file);
				total += file.size;
			});
			files = _files;
		}
		unlink = unlink.map(function(item){ return item.file; });
		_unlink(unlink, function(){
			if (l.options.debug) console.error("[clean] deleted", unlink.length, "files");
			if (l.options.debug) console.error("[clean] kept", files.length, "files with a total size of", _rfilesize(total));
			if (typeof callback === "function") callback(null, unlink, files);
		});
	});
};

/* make filename parameter safe */
var _sanitize = function(s) {
	return path.normalize(s).replace(/^\//,'');
};

/* convert human-readable filesize to an integer of bytes */
var _filesize = function(s) {
	if (typeof s === "number") return s;
	if (typeof s !== "string") return 0;
	var match = s.toLowerCase().match(/^([0-9]+([\.,]([0-9]+))?)(\s*)([a-z]+)?$/);
	if (!match) return 0;
	var num = parseFloat(match[1].replace(/,/,'.'));
	switch (match[5]) {
		case "k":
		case "kb":
		case "kbyte":
			return Math.round(num * Math.pow(10, 3));
		break;
		case "m":
		case "mb":
		case "mbyte":
			return Math.round(num * Math.pow(10, 6));
		break;
		case "g":
		case "gb":
		case "gbyte":
			return Math.round(num * Math.pow(10, 9));
		break;
		case "t":
		case "tb":
		case "tbyte":
			return Math.round(num * Math.pow(10, 12));
		break;
		case "p":
		case "pb":
		case "pbyte":
			/* be aware that javascript can't represent much more than 9 of those because integers are only 2^53 */
			return Math.round(num * Math.pow(10, 15));
		break;
		case "ki":
		case "kib":
		case "kibi":
		case "kibyte":
		case "kibibyte":
			return Math.round(num * Math.pow(2, 10));
		break;
		case "mi":
		case "mib":
		case "mebi":
		case "mibyte":
		case "mebibyte":
			return Math.round(num * Math.pow(2, 20));
		break;
		case "gi":
		case "gib":
		case "gibi":
		case "gibyte":
		case "gibibyte":
			return Math.round(num * Math.pow(2, 30));
		break;
		case "ti":
		case "tib":
		case "tebi":
		case "tibyte":
		case "tebibyte":
			return Math.round(num * Math.pow(2, 40));
		break;
		case "pi":
		case "pib":
		case "pebi":
		case "pibyte":
		case "pebibyte":
			/* be aware that javascript can't represent more than 8 of those because integers are only 2^53 */
			return Math.round(num * Math.pow(2, 50));
		break;
		default:
			/* everything else is treated as bytes */
			return Math.round(num);
		break;
	}
};

/* make human readable filesize with decimal prefixes */
var _rfilesize = function(n) {
	if (n < 1000) return (n).toFixed(0)+"B";
	if (n < 1000000) return (n/1000).toFixed(2)+"KB";
	if (n < 1000000000) return (n/1000000).toFixed(2)+"MB";
	if (n < 1000000000000) return (n/1000000000).toFixed(2)+"GB";
	if (n < 1000000000000000) return (n/1000000000000).toFixed(2)+"TB";
	return (n/1000000000000000).toFixed(2)+"PB";
};

/* read a directory recursively and call back some stats */
var _readdir = function(_path, callback) {

	var list = []

	fs.readdir(_path, function(err, files) {
		if (err) return callback(err)

		var pending = files.length
		if (pending === 0) return callback(null, list)

		files.forEach(function(file) {

			fs.stat(path.join(_path, file), function(err, stats) {
				if (err) return callback(err);

				if (stats.isDirectory()) {
					files = _readdir(path.join(_path, file), function(err, res) {
						list = list.concat(res)
						if ((--pending) === 0) callback(null, list)
					});
				} else if (stats.isFile()){
					list.push({
						file: path.join(_path, file), 
						size: stats.size, 
						atime: stats.atime.getTime()
					});
					if ((--pending) === 0) callback(null, list)
				} else {
					if ((--pending) === 0) callback(null, list)
				}
			})
		});
	});
};

/* recursively create a direcroty */
var _mkdir = function(dir, callback) {
	if (typeof callback !== "function") var callback = function(){};
	var _dir = path.resolve(dir);
	fs.exists(_dir, function(exists){
		if (exists) return callback(null);
		_mkdir(path.dirname(_dir), function(err){
			if (err) return callback(err);
			fs.mkdir(_dir, function(err){
				callback(err);
			});
		});
	});
};

/* unlink an array of files */
var _unlink = function(_files, callback) {
	var pending = _files.length;
	if (((pending) === 0) && (typeof callback === "function")) callback();
	_files.forEach(function(_file){
		fs.unlink(_file, function(err){
			if (((--pending) === 0) && (typeof callback === "function")) callback();
		});
	});
};

/* export */
module.exports = lrufiles;