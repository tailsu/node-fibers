"use strict";
var Fiber = require('./fibers');
var util = require('util');
module.exports = Future;
Function.prototype.future = function() {
	var fn = this;
	var ret = function() {
		return new FiberFuture(fn, this, arguments);
	};
	ret.toString = function() {
		return '<<Future '+ fn+ '.future()>>';
	};
	return ret;
};

Future.activeFutures = [];
var activeFutureCtorStack = [];

function addActiveFuture(future) {
	Future.activeFutures.push(future);
	activeFutureCtorStack.push(new Error().stack);
}

function deleteActiveFuture(future) {
	var index = Future.activeFutures.indexOf(future);
	if (index !== -1) {
		Future.activeFutures.splice(index, 1);
		activeFutureCtorStack.splice(index, 1);
	}
}

function Future() {
	addActiveFuture(this);
}

/**
 * Wrap a node-style async function to return a future in place of using a callback.
 */
Future.wrap = function(fn, idx) {
	idx = idx === undefined ? fn.length - 1 : idx;
	return function() {
		var args = Array.prototype.slice.call(arguments);
		if (args.length > idx) {
			throw new Error('function expects no more than '+ idx+ ' arguments');
		}
		var future = new Future;
		args[idx] = future.resolver();
		fn.apply(this, args);
		return future;
	};
};

/**
 * Creates a future returning the given result value.
 */
Future.fromResult = function(value) {
	var future = new Future();
	future.return(value);
	return future;
}

Future.assertNoFutureLeftBehind = function() {
	if (Future.activeFutures.length > 0) {
		var message = ["There are outstanding futures. Construction call stacks:"];
		for (var i = 0; i < Future.activeFutures.length; ++i) {
			message.push("#" + (i+1).toString());
			var stack = activeFutureCtorStack[i].split("\n");
			stack.shift();
			while (stack[0] && stack[0].indexOf("future.js") !== -1)
				stack.shift();
			message.push(stack.join("\n"));
		}
		throw new Error(message.join("\n"));
	}
}

function getUnresolvedFutures() {
	var futures = [];
	for (var ii = 0; ii < arguments.length; ++ii) {
		var arg = arguments[ii];
		if (arg instanceof Future) {
			// Ignore already resolved fibers
			if (arg.isResolved()) {
				continue;
			}
			futures.push(arg);
		} else if (arg instanceof Array) {
			for (var jj = 0; jj < arg.length; ++jj) {
				var aarg = arg[jj];
				if (aarg instanceof Future) {
					// Ignore already resolved fibers
					if (aarg.isResolved()) {
						continue;
					}
					futures.push(aarg);
				} else {
					throw new Error(aarg+ ' is not a future');
				}
			}
		} else {
			throw new Error(arg+ ' is not a future');
		}
	}
	return futures;
}

/**
 * Wait on a series of futures and then return. If the futures throw an exception this function
 * /won't/ throw it back. You can get the value of the future by calling get() on it directly. If
 * you want to wait on a single future you're better off calling future.wait() on the instance.
 */
Future.settle = function settle(/* ... */) {
	var futures = getUnresolvedFutures.apply(null, arguments);

	// pull out a FiberFuture for reuse if possible
	var singleFiberFuture;
	for (var i = 0; i < futures.length; ++i) {
		var candidateFuture = futures[i];
		if (candidateFuture instanceof FiberFuture && !candidateFuture.started) {
			singleFiberFuture = candidateFuture;
			futures.splice(i, 1);
			break;
		}
	}

	// Resumes current fiber
	var fiber = Fiber.current;
	if (!fiber) {
		throw new Error('Can\'t wait without a fiber');
	}

	// Resolve all futures
	var pending = futures.length + (singleFiberFuture ? 1 : 0);
	function cb() {
		if (!--pending) {
			fiber.run();
		}
	}
	for (var ii = 0; ii < futures.length; ++ii) {
		futures[ii].resolve(cb, undefined, true);
	}

	// Reusing a fiber?
	if (singleFiberFuture) {
		singleFiberFuture.started = true;
		try {
			singleFiberFuture.return(
				singleFiberFuture.fn.apply(singleFiberFuture.context, singleFiberFuture.args));
		} catch(e) {
			singleFiberFuture.throw(e);
		}
		--pending;
	}

	// Yield this fiber
	if (pending) {
		Fiber.yield();
	}

	if (singleFiberFuture) {
		futures.push(singleFiberFuture);
	}
	return futures;
};

Future.wait = function wait() {
	var futures = Future.settle.apply(null, arguments);
	var errors;

	for (var i = 0; i < futures.length; ++i) {
		var settled = futures[i];
		deleteActiveFuture(settled);
		if (settled.resolved && settled.error) {
			(errors || (errors = [])).push(settled.error);
		}
	}

	if (errors) {
		if (errors.length === 1) {
			throw errors[0];
		} else {
			var error = new Error();
			error.innerErrors = errors;
			error.toString = function() {
				var message = ["Multiple exceptions were thrown."];
				for (var ei = 0; ei < errors.length; ++ei) {
					var err = errors[ei];
					message.push(err.stack ? err.stack : err);
				}
				return message.join("\n\n");
			};
			throw error;
		}
	}
};

Future.prototype = {
	/**
	 * Return the value of this future. If the future hasn't resolved yet this will throw an error.
	 */
	get: function() {
		deleteActiveFuture(this);
		if (!this.resolved) {
			throw new Error('Future must resolve before value is ready');
		} else if (this.error) {
			// Link the stack traces up
			var stack = {}, error = this.error instanceof Object ? this.error : new Error(this.error);
			var longError = Object.create(error);
			Error.captureStackTrace(stack, Future.prototype.get);
			Object.defineProperty(longError, 'stack', {
				get: function() {
					var baseStack = error.stack;
					if (baseStack) {
						baseStack = baseStack.split('\n');
						return [baseStack[0]]
							.concat(stack.stack.split('\n').slice(1))
							.concat('    - - - - -')
							.concat(baseStack.slice(1))
							.join('\n');
					} else {
						return stack.stack;
					}
				},
				enumerable: true,
			});
			throw longError;
		} else {
			return this.value;
		}
	},

	/**
	 * Mark this future as returned. All pending callbacks will be invoked immediately.
	 */
	"return": function(value) {
		if (this.resolved) {
			throw new Error('Future resolved more than once');
		}
		this.value = value;
		this.resolved = true;

		var callbacks = this.callbacks;
		if (callbacks) {
			delete this.callbacks;
			for (var ii = 0; ii < callbacks.length; ++ii) {
				try {
					var ref = callbacks[ii];
					if (ref[1]) {
						ref[1](value);
					} else {
						ref[0](undefined, value);
					}
				} catch(ex) {
					// console.log('Resolve cb threw', String(ex.stack || ex.message || ex));
					process.nextTick(function() {
						throw(ex);
					});
				}
			}
		}
	},

	/**
	 * Throw from this future as returned. All pending callbacks will be invoked immediately.
	 */
	"throw": function(error) {
		if (this.resolved) {
			throw new Error('Future resolved more than once');
		} else if (!error) {
			throw new Error('Must throw non-empty error');
		}
		this.error = error;
		this.resolved = true;

		var callbacks = this.callbacks;
		if (callbacks) {
			delete this.callbacks;
			for (var ii = 0; ii < callbacks.length; ++ii) {
				try {
					var ref = callbacks[ii];
					if (ref[1]) {
						ref[0].throw(error);
					} else {
						ref[0](error);
					}
				} catch(ex) {
					// console.log('Resolve cb threw', String(ex.stack || ex.message || ex));
					process.nextTick(function() {
						throw(ex);
					});
				}
			}
		}
	},

	/**
	 * "detach" this future. Basically this is useful if you want to run a task in a future, you
	 * aren't interested in its return value, but if it throws you don't want the exception to be
	 * lost. If this fiber throws, an exception will be thrown to the event loop and node will
	 * probably fall down.
	 */
	detach: function() {
		this.resolve(function(err) {
			if (err) {
				throw err;
			}
		});
	},

	/**
	 * Returns whether or not this future has resolved yet.
	 */
	isResolved: function() {
		return this.resolved === true;
	},

	/**
	 * Returns a node-style function which will mark this future as resolved when called.
	 */
	resolver: function() {
		return function(err, val) {
			if (err) {
				this.throw(err);
			} else {
				this.return(val);
			}
		}.bind(this);
	},

	/**
	 * Waits for this future to resolve and then invokes a callback.
	 *
	 * If two arguments are passed, the first argument is a future which will be thrown to in the case
	 * of error, and the second is a function(val){} callback.
	 *
	 * If only one argument is passed it is a standard function(err, val){} callback.
	 */
	resolve: function(arg1, arg2, noDeactivate) {
		if (!noDeactivate) {
			deleteActiveFuture(this);
		}

		if (this.resolved) {
			if (arg2) {
				if (this.error) {
					arg1.throw(this.error);
				} else {
					arg2(this.value);
				}
			} else {
				arg1(this.error, this.value);
			}
		} else {
			(this.callbacks = this.callbacks || []).push([arg1, arg2]);
		}
		return this;
	},

	/**
	 * Resolve only in the case of success
	 */
	resolveSuccess: function(cb) {
		this.resolve(function(err, val) {
			if (err) {
				return;
			}
			cb(val);
		});
		return this;
	},

	/**
	 * Propogate results to another future.
	 */
	proxy: function(future) {
		this.resolve(function(err, val) {
			if (err) {
				future.throw(err);
			} else {
				future.return(val);
			}
		});
	},

	/**
	 * Propogate only errors to an another future or array of futures.
	 */
	proxyErrors: function(futures) {
		this.resolve(function(err) {
			if (!err) {
				return;
			}
			if (futures instanceof Array) {
				for (var ii = 0; ii < futures.length; ++ii) {
					futures[ii].throw(err);
				}
			} else {
				futures.throw(err);
			}
		});
		return this;
	},

	/**
	 * Waits for the future to settle. If the future throws an error, then wait() will rethrow that error.
	 */
	wait: function() {
		if (this.isResolved()) {
			return this.get();
		}
		Future.settle(this);
		return this.get();
	},
};

/**
 * A function call which loads inside a fiber automatically and returns a future.
 */
function FiberFuture(fn, context, args) {
	this.fn = fn;
	this.context = context;
	this.args = args;
	this.started = false;
	addActiveFuture(this);
	var that = this;
	process.nextTick(function() {
		if (!that.started) {
			that.started = true;
			Fiber(function() {
				try {
					that.return(fn.apply(context, args));
				} catch(e) {
					that.throw(e);
				}
			}).run();
		}
	});
}
util.inherits(FiberFuture, Future);
