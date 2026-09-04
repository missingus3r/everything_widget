// Magnet links a partir del infohash (main process).
//
// Los archivos históricos guardan el hash y NO el magnet: con trackers el
// magnet pesa ~700 bytes y, multiplicado por cientos de miles de releases,
// era la mitad del tamaño de la base. Se rearma al leer, que sale gratis.

// Trackers públicos que recomienda YTS; los mismos que usa LimeTorrents acá.
const TRACKERS = [
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:80',
  'udp://tracker.coppersurfer.tk:6969',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://torrent.gresille.org:80/announce',
  'udp://p4p.arenabg.com:1337',
  'udp://tracker.leechers-paradise.org:6969',
];

const TRACKER_QS = TRACKERS.map((t) => '&tr=' + encodeURIComponent(t)).join('');

function magnetFor(hash, title) {
  if (!hash) return null;
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title || 'download')}${TRACKER_QS}`;
}

module.exports = { TRACKERS, magnetFor };
