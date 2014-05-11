# lru files

A file cache inspired by [lru-cache](https://github.com/isaacs/node-lru-cache).
Least recently used files are deleted, make sure your filesystem uses `atime`.
Everything is written to files and nothing is kept in-memory.

## Install

````
npm install lru-files
````

## Usgae

```` javascript

var lrufiles = require("lru-files");

var cache = new lrufiles({
	"debug": true,    // log debug messages on stderr
	"dir": "./cache", // cache directory, relative to the parent modules path
	"files": 100,     // maximum number of files
	"size": "1 GB",   // maximum total file size
	"age": "1 Day",   // maximum last file access
	"check": "1 Hour" // interval of checks
});

cache.add("filename.ext", new Buffer("data"));

cache.add("otherfile.ext", fs.createReadableStream("/some/filename.ext"));

cache.get("somefile.ext", function(err, buffer){
	// whatever
});

cache.stream("anyfile.ext").pipe(somewhere);

cache.check("filename.ext", function(exists){
	// whatever
});

cache.clean(); // manually remove old files

cache.purge(); // empty everything

````

## License

[Public Domain](http://unlicense.org/UNLICENSE).
