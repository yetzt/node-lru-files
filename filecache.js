#!/usr/bin/env node

// require node modules
var fs = require("fs");
var path = require("path");
var stream = require("stream");

// require npm modules
var rimraf = require("rimraf");
var mkdirp = require("mkdirp");
var queue = require("queue");
var debug = require("debug");
var dur = require("dur");

function filecache(opts, fn){
	if (!(this instanceof filecache)) return new filecache(opts, fn);

	var self = this;
	
	// get options
	self.opts = self.parseopts(opts);

	// metadata
	self.filemeta = {};

	// write operations since last save
	self.wrops = 0;
	self.lastwrite = 0;
	self.lastclean = 0;
	self.usedspace = 0;
	self.numfiles = 0;
	self.oldest = Infinity;

	// initialize
	self.init(fn);

	return this;
	
};

// check and apply options
filecache.prototype.parseopts = function(opts) {
	var self = this;
	var o = {};
	
	// determine cache directory
	if (!opts.hasOwnProperty("dir") || typeof opts.dir !== "string") opts.dir = "cache";
	o.dir = path.resolve(path.dirname(process.mainModule.filename), opts.dir);

	// determine maximal total number of files
	opts.files = (!opts.hasOwnProperty("files")) ? false : parseInt(opts.files,10);
	o.files = (isNaN(opts.files) || opts.files === 0) ? false : opts.files;

	// determine maximal total file size
	if (!opts.hasOwnProperty("size")) opts.size = false;
	if (typeof opts.size === "string") opts.size = self.filesize(opts.size);
	if (typeof opts.size !== "number" || isNaN(opts.size) || opts.size === 0) opts.size = false;
	o.size = opts.size;

	// determine maximal file age
	if (!opts.hasOwnProperty("age")) opts.age = false;
	if (typeof opts.age === "string") opts.age = dur(opts.age);
	if (typeof opts.age !== "number" || isNaN(opts.age) || opts.age === 0) opts.age = false;
	o.age = opts.age;

	// determine cleanup interval
	if (!opts.hasOwnProperty("check")) opts.check = false;
	if (typeof opts.check === "string") opts.check = dur(opts.check);
	if (typeof opts.check !== "number" || isNaN(opts.check) || opts.check === 0) opts.check = false;
	o.check = (opts.check) ? opts.check : Math.max(opts.check, 10000); // minimum 10 seconds

	// determine persist
	if (!opts.hasOwnProperty("persist")) opts.persist = false;
	if (typeof opts.persist === "string") opts.persist = dur(opts.persist);
	if (typeof opts.persist !== "number" || isNaN(opts.persist) || opts.persist === 0) opts.persist = false;
	o.persist = opts.persist;
	
	// cluster
	o.cluster = (opts.hasOwnProperty("cluster") && opts.cluster === true) ? true : false;
	if (o.cluster && opts.hasOwnProperty("onsave") && typeof opts.onsave === "function") o.onsave = opts.onsave;
	
	return o;
};

// initialize file cache
filecache.prototype.init = function(fn) {
	var self = this;
	
	// ensure callback
	if (!fn || typeof fn !== "function") var fn = function(err){ if (err) return debug("initialization error: %s", err); };
	
	// ensure dir is available
	mkdirp(self.opts.dir, function(err){
		if (err) return fn(err);

		// read directory and add files to local metadata 
		self.readdir(self.opts.dir, function(err, files){
			if (err) return fn(err);

			self.numfiles = files.length;
			files.forEach(function(f){
				self.filemeta[f.file] = [f.atime, f.size];
				self.usedspace += f.size;
			});
			
			(function(next){
				// FIXME: check if metadata should be used
				
				// check if saved metadata file exists
				fs.exists(path.resolve(self.opts.dir, ".filecache.json"), function(x){
					if (!x) return next(null);

					fs.readFile(path.resolve(self.opts.dir, ".filecache.json"), function(err, content){
						return next(err);
						
						try {
							var metadata = JSON.parse(content.toString());
						} catch (err) {
							return next(err);
						}
						
						metadata.forEach(function(record){
							// set atime to time from metadata cache, if cached atime is greater than fs atime (because fs atime is unreliable)
							if (self.filemeta.hasOwnProperty(record[0]) && self.filemeta[record[0]].atime < record[1]) self.filemeta[record[0]].atime = record[1];
						});
						
						// determine oldest file if need be
						if (self.opts.age) {
							self.oldest = Infinity;
							Object.keys(self.filemeta).forEach(function(k){ self.oldest = Math.min(self.oldest, self.filemeta[k].atime); });
						}
						
						next(null);
						
					});

				});
			})(function(err){
				
				// call back immediately
				fn(err, self);
				
				// setup cleanup timer
				if (self.opts.check && (self.opts.files || self.opts.size || self.opts.age)) setInterval(function(){

					// execute cleanup if need be
					if (self.opts.files && self.opts.files < self.numfiles) return self.clean();
					if (self.opts.size && self.opts.size < self.usedspace) return self.clean();
					if (self.opts.age && (Date.now()-(self.opts.age+3600000)) > self.oldest) return self.clean();
					debug("noting to cleanup");
					
				}, self.opts.check).unref();
				
				// setup metadata save timer
				if (self.opts.persist) setInterval(function(){

					// check if 1000 write operations have happened or last save is older than 5 minutes
					if (self.wrops < 1000 && self.lastwrite+300000 < Date.now()) return;

					self.save(function(err){
						self.wrops = 0;
						if (err) debug("could not save metadata file");
						if (!err) debug("saved metadata file");
						
					});

				}, self.opts.persist).unref();

			});
		
		});

	});
	
	return this;
};

// check if a file exists
filecache.prototype.check = function(file, fn) {
	var self = this;
	fs.exists(path.resolve(self.opts.dir, self.sanitize(file)), fn);
	return this;
};

// add a file
filecache.prototype.add = function(file, data, fn) {
	var self = this;
		
	var file = path.resolve(this.opts.dir, self.sanitize(file));
	
	// if no callback given, create a default callback with error logging
	if (typeof fn !== "function") var fn = function(err){
		debug("[add] error: %s", err);
	};
	
	// make sure the direcotry exists
	mkdirp(path.dirname(file), function(err){
		if (err) return fn(err);

		(function(done){
			
			if ((data instanceof stream) || (data instanceof stream.Readable) || (data.readable === true)) {

				// pipe stream to file
				data.pipe(fs.createWriteStream(file).on("finish", function(){
					done(null, file);
				}).on("error", function(err){
					done(err);
				}));

			} else if (data instanceof Buffer) {

				// write buffer to file
				fs.writeFile(file, data, function(err){
					if (err) return done(err);
					done(null, file);
				});

			} else if (typeof data === "object") {

				// serialize object and write to file
				try {
					fs.writeFile(file, JSON.stringify(data), function(err){
						if (err) return done(err);
						done(null, file);
					});
				} catch (err) {
					return done(err);
				};

			} else {

				// write to file
				fs.writeFile(file, data, function(err){
					if (err) return done(err);
					done(null, file);
				});

			};

		})(function(err, file){
			if (err) return debug("error saving file '%s': %s", file, err) || fn(err, file);

			// get stat and add to filemeta
			fs.stat(file, function(err, stats) {
				if (err) return debug("error getting stats for file %s: %s", file, err);

				// substract file size if file is known
				if (self.filemeta.hasOwnProperty(file)) {
					self.usedspace -= self.filemeta[file].size;
					self.numfiles--;
				}

				// add file to result
				self.filemeta[file] = { file: file, size: stats.size, atime: Date.now() };
							
				// update stats
				self.wrops++;
				self.numfiles++;
				self.usedspace += self.filemeta[file].size;
				self.oldest = Math.min(self.oldest, self.filemeta[file].atime);

				fn(null, file);

			});
			
		});

	});
	
	return this;
};

// remove file from cache
filecache.prototype.remove = function(file, fn) {
	var self = this;
	
	var file = path.resolve(this.opts.dir, self.sanitize(file));
	
	fs.exists(file, function(x){
		if (!x) return debug("remove: file '%s' does not exist", file) || fn(null);

		fs.unlink(file, function(err){
			if (err) return debug("remove: could not unlink file '%s': %s", file, err) || fn(err);
			
			// update filemeta
			self.usedspace -= self.filemeta[file].size;
			self.numfiles--;
			self.wrops++;
			delete self.filemeta[file];
			
			fn(null);
			
		});

	});
	
	return this;
};

// update file access time
filecache.prototype.touch = function(file, fn) {
	var self = this;
	
	var file = path.resolve(this.opts.dir, self.sanitize(file));
	
	if (!self.filemeta.hasOwnProperty(file)) return fn(null);
	self.filemeta[file].atime = Date.now();
	fn(null);
	
	return this;
};

// get a file as buffer
filecache.prototype.get = function(file, fn) {
	var self = this;
	
	var file = path.resolve(this.opts.dir, self.sanitize(file));
	
	fs.exists(file, function(x){
		if (!x) return debug("get: file '%s' does not exist", file) || fn(new Error("file does not exists"));
		fs.readFile(file, function(err, buffer){
			if (err) return debug("get: error reading file '%s': %s", file, err) || fn(err);
			fn(null, buffer);
		});
	});
	
	return this;
};

// get a file as stream
filecache.prototype.stream = function(file, fn) {
	var self = this;
	var file = path.resolve(this.opts.dir, self.sanitize(file));

	if (typeof fn === "function") {
		fs.exists(file, function(x){
			if (!x) return debug("stream: file '%s' does not exist") || fn(new Error("file does not exists"));
			fn(null, fs.createReadStream(file));
		});
		return this;
	} else {
		return fs.createReadStream(file);
	}
};

// empty the file store
filecache.prototype.purge = function(fn) {
	var self = this;
	
	// optionalize callback
	if (typeof fn !== "function") var fn = function(err){};
	
	rimraf(self.opts.dir, function(err){
		if (err) return debug("error purging directory '%s': %s", self.opts.dir, err) || fn(err);
		debug("purged directory '%s'", self.opts.dir);
		
		// metadata
		self.filemeta = {};
		self.wrops = 0;
		self.lastwrite = 0;
		self.lastclean = 0;
		self.usedspace = 0;
		self.numfiles = 0;
		self.oldest = Infinity;
		
		fn(null);
	});
};

// cleanup files
filecache.prototype.clean = function(fn) {
	var self = this;
	
	// optionalize callback
	if (typeof fn !== "function") var fn = function(err, num){
		if (err) return debug("cleanup error: %s", err);
		debug("cleanup: %d files thrown away", num);
	};
	
	// 
	var files = [];
	var remove = [];
	var size = 0;
	var rems = 0;
	
	// collect files
	var minatime = (Date.now()-self.opts.age);
	Object.keys(self.filemeta).forEach(function(k){
		
		// check for age violation
		if (self.opts.age && minatime > self.filemeta[k].atime) {
			rems += self.filemeta[k].size;
			remove.push(self.filemeta[k]);
		} else {
			size += self.filemeta[k].size;
			files.push(self.filemeta[k]);
		}
		
	});
	
	// sort by atime
	files = files.sort(function(a,b){
		return a.atime - b.atime; // FIXME: is this sort right?
	});
	
	// check for filecount violation
	if (self.opts.files) while (files.length > self.opts.files) {
		size -= files[0].size;
		rems += files[0].size;
		remove.push(files.shift());
	};
	
	// check for filesize violations
	if (self.opts.size) while (self.opts.size < size) {
		size -= files[0].size;
		rems += files[0].size;
		remove.push(files.shift());
	};
	
	// check if there are removable files
	if (remove.length === 0) return fn(null);
	
	// remove files
	var remove_files = remove.filter(function(v){ return v.file; });

	self.unlink(remove_files, function(err, failed){
		if (err) return fn(err);
		if (failed.length > 0) {
			debug("cleanup: failed to remove %d files");
			failed.forEach(function(f){
				// readd to files
				files.push(self.filemeta[k]);
				size += self.filemeta[k].size;
				rems -= self.filemeta[k].size;
			});
		}
		
		// show stats
		debug("cleanup: removed %d files, freed %s of space", (remove_files.length-failes.length), self.rfilesize(rems));
		
		// set filemeta and stats, find oldest
		self.filemeta = {};
		var oldest = Infinity;
		files.forEach(function(f){
			self.filemeta[f.file] = f;
			oldest = Math.min(oldest, f.atime);
		});
		self.lastclean = Date.now();
		self.usedspace = size;
		self.numfiles = files.length;
		self.oldest = oldest;
		
		// save filemeta
		self.save(fn);
				
	});
	
	return this;
};

// save file meta
filecache.prototype.save = function(fn) {
	var self = this;
	
	// check if persistance file should be used
	if (!self.opts.persist) return fn(null);
	
	// if cluster, call save callback
	console.log("save callback?");
	if (self.opts.cluster && (typeof self.opts.onsave === "function")) {
		console.log("save callback!");
		self.opts.onsave();
	}
	
	// save file meta
	fs.writeFile(path.resolve(self.opts.dir, ".filecache.json"), JSON.stringify(self.filemeta), function(err){
		self.lastwrite = Date.now();
		if (err) return debug("save: error daving .filecache.json: %s", err) || fn(err);
		debug("saved .filecache.json");
		fn(null);
	});
	
	return this;
};

// make filename parameter safe
filecache.prototype.sanitize = function(f) {
	return path.normalize(f).replace(/^\//,'');
};

// convert human-readable filesize to an integer of bytes
filecache.prototype.filesize = function(s) {
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
			// be aware that javascript can't represent much more than 9 of those because integers are only 2^53
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
			// be aware that javascript can't represent more than 8 of those because integers are only 2^53
			return Math.round(num * Math.pow(2, 50));
		break;
		default:
			// everything else is treated as bytes
			return Math.round(num);
		break;
	}
};

// make human readable filesize with decimal prefixes
filecache.prototype.rfilesize = function(n) {
	n = parseInt(n,10);
	if (isNaN(n)) return "Invalid size";
	if (n < 1000) return (n).toFixed(0)+"B";
	if (n < 1000000) return (n/1000).toFixed(2)+"KB";
	if (n < 1000000000) return (n/1000000).toFixed(2)+"MB";
	if (n < 1000000000000) return (n/1000000000).toFixed(2)+"GB";
	if (n < 1000000000000000) return (n/1000000000000).toFixed(2)+"TB";
	return (n/1000000000000000).toFixed(2)+"PB";
};

// read a directory recursively and call back some stats
filecache.prototype.readdir = function(p, fn) {
	var self = this;
	var result = [];
	
	fs.readdir(p, function(err, files) {
		if (err) return debug("error reading dir '%s': %s", p, err) || fn(err, result);
		if (files.length === 0) return fn(null, result)

		var q = queue();

		files.forEach(function(f) {
			var fp = path.join(p, f);
			q.push(function(next){

				fs.stat(fp, function(err, stats) {
					if (err) return next(err);

					// add directory to queue
					if (stats.isDirectory()) q.push(function(done){
						self.readdir(fp, function(err, res){
							result = result.concat(res);
							done(err);
						});
					});

					// add file to result
					if (stats.isFile()) result.push({ file: fp, size: stats.size, atime: stats.atime.getTime() });
					next(null);
				});
			});
		});
		
		// run queue
		q.start(function(err){
			return fn(err||null, result);
		});
		
	});
};

// unlink an array of files
filecache.prototype.unlink = function(files, fn) {
	var self = this;

	// ensure files is an array of strings
	var files = ((files instanceof Array) ? files : [files]).filter(function(file){ return (typeof file === "string" && file !== ""); });

	// keep failed files
	var failed = [];

	// check if there is nothing to do
	if (files.length === 0) return fn(null, failed);
	
	// create queue
	var q = queue({ concurrency: 5 });
		
	// push delete action to queue
	files.forEach(function(file){
		q.push(function(next){
			fs.unlink(file, function(err){
				if (err) debug("error unlinking file '%s': %s", file, err) || failed.push(file);
				next();
			});
		});
	});

	// run queue
	q.start(function(){
		debug("unlinked %d of %d files", (files.length+failed.length), files.length);
		return fn(null, failed);
	});
	
	return this;
};

// handle cluster messages
filecache.prototype.handle = function(message){
	var self = this;
	if (!self.opts.cluster) return this;
	
	switch (message.action) {
		case "add":
			// add item to cache
			if (self.filemeta.hasOwnProperty(message.file)) {
				self.filemeta[message.file].atime = Date.now();
			} else {
				self.filemeta[message.file] = message.data;
				self.usedspace += self.filemeta[message.file].size;
				self.numfiles++;
				self.wrops++;
			}
		break;
		case "touch":
			// update atime in cache
			self.filemeta[message.file].atime = Date.now();
		break;
		case "remove":
			// update stats and remove item from cache
			self.usedspace -= self.filemeta[message.file].size;
			self.numfiles--;
			self.wrops++;
			delete self.filemeta[message.file];
		break;
		case "save":
			// reset save timer
			self.lastwrite = Date.now();
		break;
	}
	
	return this;
}

// export
module.exports = filecache;