'use strict';

var libQ = require('kew');
var libNet = require('net');
var fs = require('fs-extra');
var config = new (require('v-conf'))();
var exec = require('child_process').exec;
var net = require('net');
var os = require('os');
var currentMac = '';
var pTimer = require('./pausableTimer');

var http = require('http');
var io = require('socket.io-client');
var socket = io.connect('http://localhost:3000');
var lastfm = require("simple-lastfm");
var crypto = require('crypto');

// Define the ControllerLastFM class
module.exports = ControllerLastFM;

function ControllerLastFM(context) 
{
	var self = this;
	self.previousState = null;
	self.updatingNowPlaying = false;
	self.timeToPlay = 0;
	self.apiResponse = null;
	
	this.context = context;
	this.commandRouter = this.context.coreCommand;
	this.logger = this.context.logger;
	this.configManager = this.context.configManager;
	this.previousScrobble = 
		{	artist: '',
			title: '',
			scrobbleTime: 0
		};
	this.memoryTimer;
};

ControllerLastFM.prototype.onVolumioStart = function()
{
	var self = this;
	var initialize = false;
	this.configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
	self.getConf(this.configFile);
	
	self.logger.info('[LastFM] scrobbler initiated!');
	self.logger.info('[LastFM] extended logging: ' + self.config.get('enable_debug_logging'));
	self.logger.info('[LastFM] try scrobble radio plays: ' + self.config.get('tryScrobbleWebradio'));
	self.currentTimer = new pTimer(self.context, self.config.get('enable_debug_logging'));
	
	socket.on('pushState', function (state) {
		if(!self.currentTimer)
		{
			self.currentTimer = new pTimer(self.context, self.config.get('enable_debug_logging'));
			if(self.config.get('enable_debug_logging'))
				self.logger.info('[LastFM] created new timer object');
		}
		else
		{
			if(self.config.get('enable_debug_logging'))
				self.logger.info('[LastFM] timer should be there... using the existing instance');
		}
		
		var scrobbleThresholdInMilliseconds = 0;
		if(state.service == 'mpd' || state.service == 'airplay' || state.service == 'volspotconnect2')
			scrobbleThresholdInMilliseconds = state.duration * (self.config.get('scrobbleThreshold') / 100) * 1000;
		else if (state.service == 'webradio')
			scrobbleThresholdInMilliseconds = self.config.get('webradioScrobbleThreshold') * 1000;
		
		var previousTitle = 'null';
		if(self.previousState != null && self.previousState.title != null)
			previousTitle = self.previousState.title;
		
		// Set initial previousState object
		var init = '';
		if(self.previousState == null)
		{
			self.logger.info('[LastFM] initializing previous state object.');
			self.previousState = state;
			initialize = true;
			init = ' | Initializing: true';
		}
		
		if(self.config.get('enable_debug_logging'))
		{
			self.logger.info('--------------------------------------------------------------------// [LastFM] new state has been pushed; status: ' + state.status + ' | service: ' + state.service + ' | duration: ' + state.duration + ' | title: ' + state.title + ' | previous title: ' + previousTitle + init);
			if(self.currentTimer)
				self.logger.info('=================> [timer] is active: ' + self.currentTimer.isActive + ' | can continue: ' + self.currentTimer.canContinue + ' | timer started at: ' + self.currentTimer.timerStarted);
		}
		
		if (state.status == 'play' && (state.service == 'mpd' || state.service == 'airplay' || state.service == 'volspotconnect2' || (state.service == 'webradio' && self.config.get('tryScrobbleWebradio'))))
		{		
			if((self.previousState.artist == state.artist) && (self.previousState.title == state.title) && ((self.previousState.status == 'pause' || self.previousState == 'stop') || initialize) || (self.currentTimer && !self.currentTimer.isPaused()) && (self.previousScrobble.artist != state.artist && self.previousScrobble.title != state.title))
			{
				if(self.config.get('enable_debug_logging'))
					self.logger.info('[LastFM] artist and song are (still) the same; but not necessarily no update.');
				
				// Still the same song, but different status; continue timer is applicable, else start a new one | or the previousState has not yet been initialized.
				self.updateNowPlaying(state);
				if(state.duration > 0)
				{
					if(self.config.get('enable_debug_logging'))
						self.logger.info('[LastFM] timeToPlay for current track: ' + self.timeToPlay);
				
					if(self.timeToPlay > 0)
					{
						if(self.config.get('enable_debug_logging'))
							self.logger.info('[LastFM] Continuing scrobble, starting new timer for the remainder of ' + self.timeToPlay + ' milliseconds [' + state.artist + ' - ' + state.title + '].');
						
						self.currentTimer.stop();
						self.currentTimer.start(self.timeToPlay, function(scrobbler){
							if(self.config.get('enable_debug_logging'))
								self.logger.info('[LastFM] scrobbling from restarted timer.');
							self.scrobble(state, self.config.get('scrobbleThreshold'), scrobbleThresholdInMilliseconds);
							self.currentTimer.stop();
							self.timeToPlay = 0;
						});
					}
					else
					{
						if(scrobbleThresholdInMilliseconds > 0)
						{
							if(self.config.get('enable_debug_logging'))
								self.logger.info('[LastFM] starting new timer for ' + scrobbleThresholdInMilliseconds + ' milliseconds [' + state.artist + ' - ' + state.title + '].');
							
							self.currentTimer.stop();
							self.currentTimer.start(scrobbleThresholdInMilliseconds, function(scrobbler){							
								self.scrobble(state, self.config.get('scrobbleThreshold'), scrobbleThresholdInMilliseconds);
								self.currentTimer.stop();
								self.timeToPlay = 0;
							});
						}
						else
						{
							if(self.config.get('enable_debug_logging'))
								self.logger.info('[LastFM] can not scrobble; state object: ' + JSON.stringify(state));
						}
					}
				}
				else if (state.duration == 0 && state.service == 'webradio')
				{
					if(self.config.get('enable_debug_logging'))
						self.logger.info('[LastFM] starting new timer for ' + scrobbleThresholdInMilliseconds + ' milliseconds [webradio: ' + state.title + '].');
					
					self.currentTimer.stop();
					self.currentTimer.start(scrobbleThresholdInMilliseconds, function(scrobbler){							
						self.scrobble(state, self.config.get('scrobbleThreshold'), scrobbleThresholdInMilliseconds);
						self.currentTimer.stop();
						self.timeToPlay = 0;
					});
				}
				
				if(initialize)
						initialize = false;
			}
			else if (self.previousState.title == null || self.previousState.title != state.title)
			{
				// Scrobble new song
				// self.logger.info('[LastFM] previous state: ' + JSON.stringify(self.previousState));
				// self.logger.info('[LastFM] current state: ' + JSON.stringify(state));
				if(self.config.get('enable_debug_logging'))
					self.logger.info('[LastFM] previous title does not match current title, evaluating timer settings...');
				
				self.updateNowPlaying(state);

				if(self.config.get('enable_debug_logging'))
					self.logger.info('[LastFM] timer is counting: ' + self.currentTimer.isCounting());
				
				if(state.duration > 0 && (self.currentTimer && !self.currentTimer.isCounting()))
				{
					if(self.config.get('enable_debug_logging'))
					{
						self.logger.info('[LastFM] starting new timer for ' + scrobbleThresholdInMilliseconds + ' milliseconds [' + state.artist + ' - ' + state.title + '].');
						if(scrobbleThresholdInMilliseconds == undefined || scrobbleThresholdInMilliseconds == 0)
							self.logger.info('[LastFM] state object: ' + JSON.stringify(state));
					}
					
					self.currentTimer.stop();
					self.currentTimer.start(scrobbleThresholdInMilliseconds, function(scrobbler){							
						self.scrobble(state, self.config.get('scrobbleThreshold'), scrobbleThresholdInMilliseconds);
						self.currentTimer.stop();
						self.timeToPlay = 0;
					});
					
					if(initialize)
						initialize = false;
				}
				else if (state.duration == 0 && state.service == 'webradio')
				{
					if(self.config.get('enable_debug_logging'))
						self.logger.info('[LastFM] starting new timer for ' + scrobbleThresholdInMilliseconds + ' milliseconds [webradio: ' + state.title + '].');
					
					self.currentTimer.stop();
					self.currentTimer.start(scrobbleThresholdInMilliseconds, function(scrobbler){							
						self.scrobble(state, self.config.get('scrobbleThreshold'), scrobbleThresholdInMilliseconds);
						self.currentTimer.stop();
						self.timeToPlay = 0;
					});
				}
				else
					self.logger.info('[LastFM] duration is 0, ignoring status update for [' + state.artist + ' - ' + state.title + ']');
			}
			else if (self.previousState.artist == state.artist && self.previousState.title == state.title && self.previousState.duration != state.duration && self.currentTimer.isCounting())
			{
				// Airplay fix, the duration is propagated at a later point in time
				var addition = (state.duration - self.previousState.duration) * (self.config.get('scrobbleThreshold') / 100) * 1000;
				self.logger.info('[LastFM] updating timer, previous duration is obsolete; adding ' + addition + ' milliseconds.');
				self.currentTimer.addMilliseconds(addition, function(scrobbler){							
						self.scrobble(state, self.config.get('scrobbleThreshold'), scrobbleThresholdInMilliseconds);
						self.currentTimer.stop();
						self.timeToPlay = 0;
					});				
			}
			else
			{
				if(self.config.get('enable_debug_logging'))
						self.logger.info('[LastFM] could not process current state: ' + JSON.stringify(state));
			}
			// else = multiple pushStates without change, ignoring them
		}
		else if (state.status == 'pause')
		{
			if(self.currentTimer.isCounting())
			{
				self.timeToPlay = self.currentTimer.pause();
				self.previousState = state;
			}
		}
		else if (state.status == 'stop')
		{
			if(self.config.get('enable_debug_logging'))
				self.logger.info('[LastFM] stopping timer, song has ended.');
			
			if(self.currentTimer.isCounting())
			{
				self.currentTimer.stop();
				self.previousState = state;
			}
			self.timeToPlay = 0;
		}
		
		self.previousState = state;
	});
	
	return libQ.resolve();	
};

ControllerLastFM.prototype.getConfigurationFiles = function()
{
	return ['config.json'];
};

// Plugin methods -----------------------------------------------------------------------------
ControllerLastFM.prototype.onStop = function() {
	var self = this;
	self.logger.info("Performing onStop action");
	
	return libQ.resolve();
};

ControllerLastFM.prototype.stop = function() {
	var self = this;
	self.logger.info("Performing stop action");
	
	return libQ.resolve();
};

ControllerLastFM.prototype.onStart = function() {
	var self = this;
	self.logger.info("Performing onStart action");
	self.addToBrowseSources();
	
	return libQ.resolve();
};

ControllerLastFM.prototype.onRestart = function() 
{
	var self = this;
	self.logger.info("Performing onRestart action");
};

ControllerLastFM.prototype.onInstall = function() 
{
	var self = this;
	self.logger.info("Performing onInstall action");
};

ControllerLastFM.prototype.onUninstall = function() 
{
	// Perform uninstall tasks here!
	self.logger.info("Performing onUninstall action");
};

ControllerLastFM.prototype.getUIConfig = function() {
    var self = this;
	var defer = libQ.defer();    
    var lang_code = this.commandRouter.sharedVars.get('language_code');
	self.getConf(this.configFile);
	self.logger.info("Loaded the previous config.");
	
	self.generateDependencylist();
	
	var thresholds = fs.readJsonSync((__dirname + '/options/thresholds.json'),  'utf8', {throws: false});
	
	self.commandRouter.i18nJson(__dirname+'/i18n/strings_' + lang_code + '.json',
		__dirname + '/i18n/strings_en.json',
		__dirname + '/UIConfig.json')
    .then(function(uiconf)
    {
		self.logger.info("## populating UI...");
		
		// Credentials settings
		uiconf.sections[0].content[0].value = self.config.get('API_KEY');
		uiconf.sections[0].content[1].value = self.config.get('API_SECRET');		
		uiconf.sections[0].content[2].value = self.config.get('username');
		if(self.config.get('password') != undefined && self.config.get('password') != '')
			uiconf.sections[0].content[3].value = self.config.get('password');
		else
			uiconf.sections[0].content[3].value = '******';
		self.logger.info("1/3 settings loaded");
		
		// Scrobble settings
		for (var n = 0; n < thresholds.percentages.length; n++){
			self.configManager.pushUIConfigParam(uiconf, 'sections[1].content[0].options', {
				value: thresholds.percentages[n].perc,
				label: thresholds.percentages[n].desc
			});
			
			if(thresholds.percentages[n].perc == parseInt(self.config.get('scrobbleThreshold')))
			{
				uiconf.sections[1].content[0].value.value = thresholds.percentages[n].perc;
				uiconf.sections[1].content[0].value.label = thresholds.percentages[n].desc;
			}
		}
		uiconf.sections[1].content[1].value = self.config.get('pushToastOnScrobble');
		uiconf.sections[1].content[2].value = self.config.get('tryScrobbleWebradio');
		uiconf.sections[1].content[3].value = self.config.get('webradioScrobbleThreshold');
		self.logger.info("2/3 settings loaded");
		
		uiconf.sections[2].content[0].value = self.config.get('enable_debug_logging');
		self.logger.info("3/3 settings loaded");
		
		self.logger.info("Populated config screen.");
				
		defer.resolve(uiconf);
	})
	.fail(function()
	{
		defer.reject(new Error());
	});

	return defer.promise;
};

ControllerLastFM.prototype.setUIConfig = function(data) {
	var self = this;
	
	self.logger.info("Updating UI config");
	var uiconf = fs.readJsonSync(__dirname + '/UIConfig.json');
	
	return libQ.resolve();
};

ControllerLastFM.prototype.getConf = function(configFile) {
	var self = this;
	this.config = new (require('v-conf'))()
	this.config.loadFile(configFile)
	
	return libQ.resolve();
};

ControllerLastFM.prototype.setConf = function(conf) {
	var self = this;
	return libQ.resolve();
};

ControllerLastFM.prototype.addToBrowseSources = function () {
    var data = { 
		name: 'LastFM', 
		uri: 'lastfm', 
		plugin_type: 'miscellanea', 
		plugin_name: 'lastfm',
		icon: 'fa fa-lastfm',
		albumart: '/albumart?sourceicon=miscellanea/lastfm/lastfm.svg'
		};
    this.commandRouter.volumioAddToBrowseSources(data);
};

ControllerLastFM.prototype.handleBrowseUri = function (curUri) {
    var self = this;
    var response;
    if (curUri == 'lastfm') {
        response = self.browseRoot('lastfm');
    }
	else if (curUri.startsWith('lastfm')) {
        self.logger.info('[LastFM] browsing to: ' + curUri);
		
		if(1=1)
			response = self.getSimilarArtists(curUri);
		else if (1=2)
			response = self.getSimilarArtists(curUri);
    }
    return response
        .fail(function (e) {
            self.logger.info('[' + Date.now() + '] ' + '[LastFM] handleBrowseUri failed');
            libQ.reject(new Error());
        });
};

ControllerLastFM.prototype.browseRoot = function(uri) {
  var self = this;
  self.fTree = [ 
		{ label: 'Similar Artists', uri: 'similar_artist'},
		{ label: 'Similar Tracks', uri: 'similar_tracks'}
	];
  var defer = libQ.defer();

  var rootTree = {
    navigation: {
      lists: [
        {
          availableListViews: [
            'grid', 'list',
          ],
          items: [
          ],
        },
      ],
      prev: {
        uri: '/',
      },
    },
  };

  for (var f in self.fTree) {
    
    rootTree.navigation.lists[0].items.push({
      service: 'lastfm',
      type: 'category',
      title: self.fTree[f].label,
      artist: '',
      album: '',
      icon: 'fa fa-lastfm',
	  albumart: '',
      uri: 'lastfm/' + self.fTree[f].uri,
    });
  }

  defer.resolve(rootTree);
  return defer.promise;
};

ControllerLastFM.prototype.getSimilarArtists = function(uri) {
	var self = this;
	var defer = libQ.defer();
  
	var call = self.apiCall('', '');
	call.then(function(response){
		
		var jsonResp = JSON.parse(response);
		
		var rootTree = 
		{
			navigation: {
				lists: [
				{
					availableListViews: [
						'grid', 'list',
					],
					items: [],
				}],
				prev: {
					uri: 'lastfm/',
				},
			},
		};
		
		for (var art in jsonResp.similarartists.artist)
		{	
			rootTree.navigation.lists[0].items.push({
				service: 'lastfm',
				type: 'artist',
				title: '',
				artist: jsonResp.similarartists.artist[art].name,
				albumart: jsonResp.similarartists.artist[art].image[3]['#text'],
				uri: '',
			});
		}
		
		self.logger.info('[LastFM] items: ' + JSON.stringify(rootTree.navigation.lists[0].items));
		defer.resolve(rootTree);
	})
	.fail(function()
	{
		defer.fail(new Error('An error occurred while listing playlists'));
	});
	
	return defer.promise;
};

ControllerLastFM.prototype.getSimilarTracks = function(uri) {
	var self = this;
	var defer = libQ.defer();
  
	var call = self.apiCall('track.getsimilar', '');
	call.then(function(response){
		
		var jsonResp = JSON.parse(response);
		
		var rootTree = 
		{
			navigation: {
				lists: [
				{
					availableListViews: [
						'grid', 'list',
					],
					items: [],
				}],
				prev: {
					uri: 'lastfm/',
				},
			},
		};
		
		for (var art in jsonResp.similarartists.artist)
		{	
			rootTree.navigation.lists[0].items.push({
				service: 'lastfm',
				type: 'artist',
				title: '',
				artist: jsonResp.similarartists.artist[art].name,
				albumart: jsonResp.similarartists.artist[art].image[3]['#text'],
				uri: '',
			});
		}
		
		self.logger.info('[LastFM] items: ' + JSON.stringify(rootTree.navigation.lists[0].items));
		defer.resolve(rootTree);
	})
	.fail(function()
	{
		defer.fail(new Error('An error occurred while listing playlists'));
	});
	
	return defer.promise;
};

ControllerLastFM.prototype.apiCall = function (method, predicate)
{
	var self = this;
	var defer = libQ.defer();
	
	/*
	// method = artist.getsimilar || track.getsimilar
	// predicate = { artist: '', title: '' };
	
	var searchterm = 'artist=' + predicate.artist;
	if (method == 'track.getsimilar')
		searchterm += '&track=' + predicate.title;
	
	var url = '/2.0/?method=' + method + '&' + searchterm + '&api_key=' + self.config.get('API_KEY') + '&format=json&limit=' + self.config.get('limit');
	*/
	
	http.get({
			host: 'ws.audioscrobbler.com',
			port: 80,
			path: '/2.0/?method=artist.getsimilar&artist=cher&api_key=89e254dbf78f4793aab307c0641019ea&format=json&limit=54'
		}, function(res) {
			var body = '';
			res.on('data', function(chunk) {
				body += chunk;
			});
			res.on('end', function() {
				defer.resolve(body);
			});
		});
	
	return defer.promise;
};

// Public Methods ---------------------------------------------------------------------------------------

ControllerLastFM.prototype.updateCredentials = function (data)
{
	var self = this;
	var defer = libQ.defer();

	self.config.set('API_KEY', data['API_KEY']);
	self.config.set('API_SECRET', data['API_SECRET']);
	self.config.set('username', data['username']);
	if(data['storePassword'] && data['passowrd'] != undefined && data['passowrd'] != '' && data['passowrd'] != '******')
		self.config.set('password', data['password']);
	self.config.set('authToken', md5(data['username'] + md5(data['password'])));
	defer.resolve();
	
	self.commandRouter.pushToastMessage('success', "Saved settings", "Successfully saved authentication settings.");

	return defer.promise;
};

ControllerLastFM.prototype.updateScrobbleSettings = function (data)
{
	var self = this;
	var defer=libQ.defer();

	self.config.set('scrobbleThreshold', data['scrobbleThreshold'].value);
	self.config.set('pushToastOnScrobble', data['pushToastOnScrobble']);
	self.config.set('tryScrobbleWebradio', data['tryScrobbleWebradio']);
	self.config.set('webradioScrobbleThreshold', data['webradioScrobbleThreshold']);
	defer.resolve();
	
	self.commandRouter.pushToastMessage('success', "Saved settings", "Successfully saved scrobble settings.");

	return defer.promise;
};

ControllerLastFM.prototype.updateDebugSettings = function (data)
{
	var self = this;
	var defer=libQ.defer();

	self.config.set('enable_debug_logging', data['enable_debug_logging']);
	defer.resolve();
	
	self.commandRouter.pushToastMessage('success', "Saved settings", "Successfully saved debug settings.");

	return defer.promise;
};

ControllerLastFM.prototype.updateNowPlaying = function (state)
{
	var self = this;
	var defer = libQ.defer();
	self.updatingNowPlaying = true;
	
	var artist = state.artist;
	var title = state.title;
	var album = state.album;
	
	if(state.service == 'webradio' && state.title.indexOf('-') > -1)
	{
		var info = state.title.split('-');
		artist = info[0].trim();
		title = info[1].trim();
		album = '';
	}
	
	if (
		(self.config.get('API_KEY') != '') &&
		(self.config.get('API_SECRET') != '') &&
		(self.config.get('username') != '') &&
		(self.config.get('authToken') != '') &&
		artist != undefined &&
		title != undefined &&
		album != undefined
	)
	{
		if(self.config.get('enable_debug_logging'))
			self.logger.info('[LastFM] trying to authenticate...');
				
		var lfm = new lastfm({
			api_key: self.config.get('API_KEY'),
			api_secret: self.config.get('API_SECRET'),
			username: self.config.get('username'),
			authToken: self.config.get('authToken')
		});
		
		lfm.getSessionKey(function(result) {
			if(result.success) {
				if(self.config.get('enable_debug_logging'))
					self.logger.info('[LastFM] authenticated successfully!');
				// Use the last.fm corrections data to check whether the supplied track has a correction to a canonical track
				lfm.getCorrection({
					artist: artist,
					track: title,
					callback: function(result) {
						if(result.success)
						{
							// Try to correct the artist
							if(result.correction.artist.name != undefined && result.correction.artist.name != '' && artist != result.correction.artist.name)
							{	
								self.logger.info('[LastFM] corrected artist from: ' + artist + ' to: ' + result.correction.artist.name);
								artist = result.correction.artist.name;
							}
							
							// Try to correct the track title
							if(result.correction.name != undefined && result.correction.name != '' && title != result.correction.name)
							{	
								self.logger.info('[LastFM] corrected track title from: ' + title + ' to: ' + result.correction.name);
								title = result.correction.name;
							}
						}
						else
							self.logger.info('[LastFM] request failed with error: ' + result.error);
					}
				})

				// Used to notify Last.fm that a user has started listening to a track. Parameter names are case sensitive.
				lfm.scrobbleNowPlayingTrack({
					artist: artist,
					track: title,
					album: album,
					callback: function(result) {
						if(!result.success)
							console.log("in callback, finished: ", result);
					}
				});
			} else {
				self.logger.info("[LastFM] Error: " + result.error);
			}
		});
	}
	else
	{
		// Configuration errors
		if(self.config.get('API_KEY') == '')
			self.logger.info('[LastFM] configuration error; "API_KEY" is not set.');
		if(self.config.get('API_SECRET') == '')
			self.logger.info('[LastFM] configuration error; "API_SECRET" is not set.');
		if(self.config.get('username') == '')
			self.logger.info('[LastFM] configuration error; "username" is not set.');
		if(self.config.get('authToken') == '')
			self.logger.info('[LastFM] configuration error; "authToken" is not set.');
	}

	//self.currentTimer = null;
	self.updatingNowPlaying = false;
	return defer.promise;
};

ControllerLastFM.prototype.scrobble = function (state, scrobbleThreshold, scrobbleThresholdInMilliseconds)
{
	var self = this;
	var defer = libQ.defer();
	
	var now = new Date().getTime();
	var artist = state.artist;
	var title = state.title;
	var album = state.album;
	
	if(state.service == 'webradio' && state.title.indexOf('-') > -1)
	{
		var info = state.title.split('-');
		artist = info[0].trim();
		title = info[1].trim();
		album = '';
	}
	
	if(self.config.get('enable_debug_logging'))
	{
		self.logger.info('[LastFM] checking previously scrobbled song...');
		self.logger.info('[LastFM] previous scrobble: ' + JSON.stringify(self.previousScrobble));
	}
		
	if (
		(self.config.get('API_KEY') != '') &&
		(self.config.get('API_SECRET') != '') &&
		(self.config.get('username') != '') &&
		(self.config.get('authToken') != '') &&
		artist != undefined &&
		title != undefined &&
		album != undefined	
	)
	{
		if(self.config.get('enable_debug_logging'))
			self.logger.info('[LastFM] trying to authenticate for scrobbling...');
		
		var lfm = new lastfm({
			api_key: self.config.get('API_KEY'),
			api_secret: self.config.get('API_SECRET'),
			username: self.config.get('username'),
			authToken: self.config.get('authToken')
		});
		
		lfm.getSessionKey(function(result) {
			if(result.success)
			{		
				if(self.config.get('enable_debug_logging'))
					self.logger.info('[LastFM] authenticated successfully for scrobbling!');
				
				// Use the last.fm corrections data to check whether the supplied track has a correction to a canonical track
				lfm.getCorrection({
					artist: artist,
					track: title,
					callback: function(result) {
						if(result.success)
						{
							//self.logger.info("[LastFM] callback, finished: ", JSON.stringify(result));
							
							// Try to correct the artist
							if(result.correction.artist.name != undefined && result.correction.artist.name != '' && artist != result.correction.artist.name)
							{	
								self.logger.info('[LastFM] corrected artist from: ' + artist + ' to: ' + result.correction.artist.name);
								artist = result.correction.artist.name;
							}
							
							// Try to correct the track title
							if(result.correction.name != undefined && result.correction.name != '' && title != result.correction.name)
							{	
								self.logger.info('[LastFM] corrected track title from: ' + title + ' to: ' + result.correction.name);
								title = result.correction.name;
							}
						}
						else
							self.logger.info('[LastFM] request failed with error: ' + result.error);
					}
				});
				
				if(self.config.get('enable_debug_logging'))
					self.logger.info('[LastFM] preparing to scrobble...');

				lfm.scrobbleTrack({
					artist: artist,
					track: title,
					album: album,
					callback: function(result) {
						if(!result.success)
							console.log("in callback, finished: ", result);
						
						if(album == '')
							album = '[unknown album]';
						
						if(self.config.get('pushToastOnScrobble'))
							self.commandRouter.pushToastMessage('success', 'Scrobble succesful', 'Scrobbled: ' + artist + ' - ' + title + ' (' + album + ').');
						self.logger.info('[LastFM] Scrobble successful for: ' + artist + ' - ' + title + ' (' + album + ').');
					}
				});	
			}
			else
			{
				self.logger.info("[LastFM] Error: " + result.error);
			}
		});
		
		self.previousScrobble.artist = artist;
		self.previousScrobble.title = title;
		self.clearScrobbleMemory((state.duration * 1000) - scrobbleThresholdInMilliseconds);
	}
	else
	{
		// Configuration errors
		if(self.config.get('API_KEY') == '')
			self.logger.info('[LastFM] configuration error; "API_KEY" is not set.');
		if(self.config.get('API_SECRET') == '')
			self.logger.info('[LastFM] configuration error; "API_SECRET" is not set.');
		if(self.config.get('username') == '')
			self.logger.info('[LastFM] configuration error; "username" is not set.');
		if(self.config.get('authToken') == '')
			self.logger.info('[LastFM] configuration error; "authToken" is not set.');
	}
	
	//self.currentTimer = null;
	return defer.promise;
};

function md5(string) {
	return crypto.createHash('md5').update(string, 'utf8').digest("hex");
}

ControllerLastFM.prototype.clearScrobbleMemory = function (remainingtimeToPlay)
{
	var self = this;
	self.memoryTimer = setInterval(function(clear)
	{
		self.previousScrobble.artist = '';
		self.previousScrobble.title = '';
	}
	, remainingtimeToPlay);
}

/*
	
	P R E P A R A T I O N   F O R   F U T U R E   F U N C T I O N A L I T I E S

*/

ControllerLastFM.prototype.statePushed = function (timeLeft)
{
	timer = setInterval(countdown, 1000);
	function countdown() {
	  if (timeLeft == 0) {
		clearTimeout(timer);
		// scrobble
	  } else {
		timeLeft--;
	  }
	}
}

ControllerLastFM.prototype.getCurrentMac = function () {
    var self = this;
    var defer = libQ.defer();
	var interfaces = os.networkInterfaces();
	var macs = [];
	var mac = '';
	
	try
	{
		//self.logger.info('###### INTERFACES: ' + JSON.stringify(interfaces));
		for (var inter in interfaces)
		{
			if(!interfaces[inter][0].internal)
			{		
				// Omit any 'empty' MAC address
				if (interfaces[inter][0].mac != '00:00:00:00:00:00')
					macs.push({ interface: inter, mac: interfaces[inter][0].mac });
			}
		}
		
		// Sort by interface: eth0, eth1, ethx, wlan0, wlan1, wlanx etc.
		macs.sort(function(a, b){
			var compA = a.interface.toLowerCase(), compB = b.interface.toLowerCase()
			if (compA < compB)
				return -1 
			if (compA > compB)
				return 1
			return 0
		});
		
		//self.logger.info('########################### MACS: ' + JSON.stringify(macs));
		currentMac = macs[0].mac;
		self.logger.info('Determined MAC: ' + currentMac);
		
		defer.resolve(mac);
	}
	catch(e)
	{
		self.logger.error('Could not determine MAC address with error: ' + e);
		defer.reject();
	}
	
    return defer.promise;
};


ControllerLastFM.prototype.generateDependencylist = function ()
{
	var self = this;
	fs.readdir(__dirname + "/node_modules", function (err, dirs)
	{
		if (err) {
			console.log(err);
			return;
		}
		
		dirs.forEach(function(dir)
		{
			if (dir.indexOf(".") !== 0)
			{
				var packageJsonFile = __dirname + "/node_modules/" + dir + "/package.json";
				if (fs.existsSync(packageJsonFile))
				{
					fs.readFile(packageJsonFile, function (err, data)
					{
						if (err)
							console.log(err);
						else
						{
							var json = JSON.parse(data);
							self.logger.info('"'+json.name+'": "^' + json.version + '",');
						}
					});
				}
			}
		});
	});
};