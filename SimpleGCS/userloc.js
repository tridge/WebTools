/*
  userloc.js - Browser Geolocation for the GCS map
  */
(() => {
    const State = {
	map: null,
	watchId: null,
	marker: null,
	accuracy: null,
	firstFix: true,
	opts: {
	    autoCenterFirstFix: true,
	    accuracyStyle: {
		color: '#2962ff',
		weight: 1,
		dashArray: '4 2',
		fillOpacity: 0.08
	    },
	    markerStyle: {
		radius: 7,
		color: '#2962ff',
		fillColor: '#2962ff',
		fillOpacity: 0.9,
		weight: 2
	    }
	}
    };

    function toast(msg, ms=1500){ try{ const el=document.createElement('div'); el.className='toast'; el.textContent=msg; document.body.appendChild(el); setTimeout(()=>el.remove(), ms);}catch{}}

    function onPos(pos){
	if (!State.map) return;
	const { latitude, longitude, accuracy } = pos.coords;
	const ll = [latitude, longitude];

	if (!State.marker) {
	    State.marker = L.circleMarker(ll, State.opts.markerStyle).addTo(State.map).bindPopup('You are here');
	} else {
	    State.marker.setLatLng(ll);
	}

	if (!State.accuracy) {
	    State.accuracy = L.circle(ll, { ...State.opts.accuracyStyle, radius: accuracy }).addTo(State.map);
	} else {
	    State.accuracy.setLatLng(ll); State.accuracy.setRadius(accuracy);
	}

	if (State.firstFix && State.opts.autoCenterFirstFix) {
	    State.map.setView(ll, Math.max(State.map.getZoom() || 0, 16));
	    State.firstFix = false;
	}
    }

    function onErr(err){
	console.warn('Geolocation error:', err);
	toast('Location error: ' + (err && err.message ? err.message : err));
	API.stop();
    }

    const API = {
	init(map, opts={}){
	    State.map = map;
	    State.opts = { ...State.opts, ...opts };
	    return API;
	},
	start(){
	    if (!('geolocation' in navigator)) { toast('Geolocation not available'); return; }
	    if (!State.map) { console.warn('UserLocation.init(map) first'); return; }
	    if (State.watchId) { toast('Location on'); return; }
	    State.firstFix = true;
	    State.watchId = navigator.geolocation.watchPosition(onPos, onErr, {
		enableHighAccuracy: true,
		maximumAge: 5000,
		timeout: 10000
	    });
	    toast('Locating…');
	},
	stop(){
	    if (State.watchId) { navigator.geolocation.clearWatch(State.watchId); State.watchId = null; }
	    if (State.marker) { try { State.map.removeLayer(State.marker); } catch{} State.marker = null; }
	    if (State.accuracy) { try { State.map.removeLayer(State.accuracy); } catch{} State.accuracy = null; }
	    State.firstFix = true;
	    toast('Location off');
	},
	toggle(){ State.watchId ? API.stop() : API.start(); },
	active(){ return !!State.watchId; }
    };

    window.UserLocation = API;
})();
