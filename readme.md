# lru files

A file cache inspired by [lru-cache](https://github.com/isaacs/node-lru-cache).
Least recently used files are deleted. It's helpful if your filesystem uses `atime`.
Everything is written to files and nothing is kept in-memory.

## Install

````
npm install lru-files
````

## Usgae

```` javascript

var lrufiles = require("lru-files");

var cache = new lrufiles({
	files: 100,       // maximum number of files
	size: "1 GB",     // maximum total file size
	age: "1 Day",     // maximum last file access
	check: "1 Hour",  // interval of checks
	persist: "1 Hour" // keep access statistics in a file, save in regular intervals
});

// add a file to cache. you can submit a buffer...
cache.add("filename.ext", new Buffer("data"), function(err){});

// ... readable stream ...
cache.add("otherfile.ext", fs.createReadableStream("/some/filename.ext"), function(err){});

// ... or object
cache.add("objectfile.json", {hello: "world"}, function(err){});

// get a file from cache
cache.get("somefile.ext", function(err, buffer){
	// calls back with a buffer
});

// get a readable stream to a cached file, straight...
cache.stream("anyfile.ext").pipe(somewhere);

// ... or via callbacl
cache.stream("anyfile.ext" function(err, stream){
	stream.pipe(somewhere);
});

// check if a file is cached
cache.check("filename.ext", function(exists){
	// whatever
});

// update a files access time
cache.touch("file/changed.txt", function(err){ });

// remove a file from cache
cache.remove("file/changed.txt", function(err){ });

// manually remove old files
cache.clean(function(err){});

// empty everything
cache.purge(function(err){});

````

## License

[Public Domain](http://unlicense.org/UNLICENSE).
