#include "bindings/bindings.h"
#import <Foundation/Foundation.h>

extern "C" void snapshot_bridge_install(void);
extern "C" void background_refresh_install(void);

// Debug-only boot tracing. Documents is readable with `devicectl device copy
// from --domain-type appDataContainer`, which is the only channel out of a
// device that dies before the Rust logger exists. Release installs must not
// accumulate this diagnostic file on every launch.
static void crumb(const char *msg) {
	#if DEBUG
	@autoreleasepool {
		NSString *dir = NSSearchPathForDirectoriesInDomains(
			NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
		if (!dir) return;
		NSString *path = [dir stringByAppendingPathComponent:@"boot.log"];
		NSString *line = [NSString stringWithFormat:@"%@ %s\n",
			[NSDate date].description, msg];
		FILE *f = fopen(path.UTF8String, "a");
		if (f) { fputs(line.UTF8String, f); fclose(f); }
	}
	NSLog(@"HTTP Widgets boot: %s", msg);
	#else
	(void)msg;
	#endif
}

int main(int argc, char * argv[]) {
	crumb("1 main entered");
	@try {
		snapshot_bridge_install();
		crumb("2 snapshot bridge installed");
	} @catch (NSException *e) {
		crumb([[NSString stringWithFormat:@"2! snapshot bridge threw %@: %@",
			e.name, e.reason] UTF8String]);
	}
	@try {
		background_refresh_install();
		crumb("3 background refresh installed");
	} @catch (NSException *e) {
		crumb([[NSString stringWithFormat:@"3! background refresh threw %@: %@",
			e.name, e.reason] UTF8String]);
	}
	crumb("4 calling start_app");
	ffi::start_app();
	crumb("5 start_app RETURNED — main is about to exit");
	return 0;
}
