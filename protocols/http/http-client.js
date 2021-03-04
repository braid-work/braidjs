var peer = Math.random().toString(36).substr(2)
var enable_cors_default = false

if (typeof module !== 'undefined' && module.exports) {
    module.exports = braid_fetch
}

var fetch
var Headers
// On nodejs, this requires "npm install node-fetch node-web-streams"
if (typeof window === 'undefined') {
    fetch = require('node-fetch')
    Headers = fetch.Headers
    var to_whatwg_stream = require('node-web-streams').toWebReadableStream
} else {
    fetch = window.fetch
    Headers = window.Headers
}

function braid_fetch (url, params = {}, onversion, onclose) {
    // Todo: when reconnecting, this needs a way of asking to continue where
    // parents left off.
    //
    //   - should it remember the parents?
    //   - or should it use a peer, or fissure id?

    if (!onclose)
        onclose = () => console.warn(`Goodbye!`)

    // Initialize the headers object
    if (!params.headers)
        params.headers = new Headers()

    // Always set the peer
    params.headers.set('peer', peer)

    // We provide some shortcuts for Braid params
    if (params.version)
        params.headers.set('version', JSON.stringify(params.version))
    if (params.parents)
        params.headers.set('parents', params.parents.map(JSON.stringify).join(', '))
    if (params.subscribe)
        params.headers.set('subscribe',
                            (typeof params.subscribe === 'number'
                             ? 'keep-alive=' + params.subscribe
                             : 'keep-alive'))

    // Prepare patches
    if (params.patches) {
        console.assert(Array.isArray(params.patches), 'Patches must be array')
        console.assert(!params.body, 'Cannot send both patches and body')

        params.patches = params.patches || []
        params.headers.set('patches', params.patches.length)
        params.body = (params.patches).map(patch => {
            var length = `content-length: ${patch.content.length}`
            var range = `content-range: ${patch.unit} ${patch.range}`
            return `${length}\n${range}\n\n${patch.content}\n`
        }).join('\n')
    }

    if (enable_cors_default)
        params.mode = params.mode || 'cors'

    // Now run the actual fetch!
    if (params.reconnect) {
        function reconnect () {
            console.debug(`Fetching ${url}`);
            fetch(url, params)
                .then(function (res) {
                    if (!res.ok) {
                        console.error("Fetch failed!", res)
                        setTimeout(reconnect, 5000)
                        return
                    }
                    parse_versions(res.body, onversion, onclose,
                                   (err) => {console.log('errrrrrr!!!!', err);
                                             setTimeout(reconnect, 5000)})
                })
                .catch((err) => {
                    console.error("GET fetch failed with: ", err)
                    onclose()
                    setTimeout(reconnect, 5000)
                })
        }
        reconnect()
    } else {
        var promise = fetch(url, params)
        promise.andThen = func => promise.then(function (res) {
            if (!res.ok) throw new Error('Subscription request failed', res)
            parse_versions(
                res.body, func, onclose,
                (err) => { throw new Error('Subscription read failed', err) }
            )
        })
        return promise
    }
}

// Parse a stream of versions from the incoming bytes
function parse_versions (stream, on_message, on_finished, on_error) {
    if (typeof window === 'undefined')
        stream = to_whatwg_stream(stream)

    // Set up a reader
    var reader = stream.getReader(),
        decoder = new TextDecoder('utf-8'),
        input_buffer = '',
        parsed_headers = false,
        parsed_patches = []
    
    
    // Process one chunk of the stream at a time.
    reader.read().then(function read ({done, value}) {

        // First check if this connection has been closed!
        if (done) {
            if (input_buffer.trim().length)
                console.debug("Connection was closed. Remaining data in buffer:", input_buffer)
            else
                console.debug("Connection was closed. Buffer was empty.")
            on_finished()
            return
        }
        
        // Transform this chunk into text that we can work with.
        var chunk_string = decoder.decode(value)
        console.debug('Received text', chunk_string)

        // Add this chunk to our input buffer
        input_buffer = (input_buffer + chunk_string)

        // Now loop through the input_buffer until we hit a dead end
        while (true) {

            // If we don't have headers yet, let's try to parse some
            if (!parsed_headers) {
                var parsedH = parse_headers()
                // Todo: Handle malformed headers by disconnecting
                if (parsedH) {
                    parsed_headers = parsedH.headers
                    // Take the parsed headers out of the buffer
                    input_buffer = input_buffer.substring(parsedH.consumed_length)
                } else {
                    console.debug("Failed to parse headers.")
                    // This means we need to exit the loop and wait for
                    // more input.
                    break
                }
            }

            // We have headers now!

            if (parse_body()) {
                // Now we have a complete message!
                console.debug("Patch parse Success:", parsed_patches)

                // Parse the versions from the HTTP structured headers format
                parsed_headers.version = JSON.parse(parsed_headers.version || 'null')
                parsed_headers.patches = parsed_patches && parsed_patches.slice()
                if (parsed_headers.parents)
                    parsed_headers.parents = JSON.parse('['+parsed_headers.parents+']')

                // Add the patches in
                parsed_headers.patches = parsed_patches

                console.debug("Assembled complete message: ", parsed_headers)

                // Now tell everyone!
                on_message(parsed_headers)

                // Reset our parser state, to read the next message
                parsed_headers = false
                parsed_patches = []

                // And let's continue reading, in case there is more stuff in
                // this chunk for us to parse!
                console.debug("Restarting in current buffer...",
                              JSON.stringify(input_buffer))
            } else {
                // Patch parsing failed.  Let's wait for more data.
                console.debug("Couldn't parse patches.")
                // Todo: Handle malformed patches by disconnecting
                break
            }
        }

        // Now let's restart the whole process
        console.debug("Waiting for next chunk to continue reading")
        reader.read().then(read).catch(on_error)
    }).catch(on_error)

    // Parsing helpers
    function parse_headers() {
        console.debug('Parsing headers from', input_buffer)
        // This string could contain a whole response.
        // So first let's isolate to just the headers.
        var headers_length = input_buffer.indexOf('\n\n')
        if (headers_length === -1) {
            console.debug('parse_headers: no double-newline')
            return false
        }
        var stuff_to_parse = input_buffer.substring(0, headers_length)
        
        // Now let's grab everything from these headers
        var headers = {},
            regex = /([\w-_]+): (.*)/g,
            tmp,
            completed = false
        while (tmp = regex.exec(stuff_to_parse)) {
            //console.debug('Parse line:', tmp)
            headers[tmp[1].toLowerCase()] = tmp[2]
            if (regex.lastIndex === headers_length) {
                completed = true
                break
            }
        }
        
        // If we couldn't consume the entire buffer, then we can crash
        if (!completed) {
            console.debug('parse_headers: not completed')
            return false
        } else
            return {headers, consumed_length: headers_length + 2}
    }

    function parse_body () {
        var content_length = parseInt(parsed_headers['content-length'])

        if (content_length) {
            console.debug("Got an absolute body")
            // This message has "body"
            if (content_length > input_buffer.length) {
                console.debug("But we don't have enough data for it yet...")
                return false
            }

            parsed_patches = [{
                range: '',
                content: input_buffer.substring(0, content_length)
            }]
            input_buffer = input_buffer.substring(content_length + 2)
            console.debug('Now, we parsed',
                          JSON.stringify(parsed_patches[0].content),
                          'and input buffer is', JSON.stringify(input_buffer))
            return true
        }
        if (parsed_headers.patches) {
            // Parse patches until we run out of patches to parse or get
            // all of them
            while (parsed_patches.length < parsed_headers.patches) {
                input_buffer = input_buffer.trimStart()
                var parsed_patch_headers = parse_headers()
                if (!parsed_patch_headers) {
                    console.debug("Failed to parse patch headers!")
                    return false
                }
                var patch_headers = parsed_patch_headers.headers
                var header_length = parsed_patch_headers.consumed_length
                // assume we have content-length...
                var length = parseInt(patch_headers['content-length'])

                // Does our current buffer contain enough data that we
                // have the entire patch?
                if (input_buffer.length < header_length + length) {
                    console.debug("Buffer is too small to contain",
                                  "the rest of the patch...")
                    return false
                }

                // Content-range is of the form '<unit> <range>' e.g. 'json .index'
                var [unit, range] = patch_headers['content-range'].match(/(\S+) (.*)/).slice(1)
                var patch_content = input_buffer.substring(header_length, header_length + length)

                // We've got our patch!
                parsed_patches.push({range, unit, content: patch_content})
                input_buffer = input_buffer.substring(header_length + length + 2)
                console.debug('Successfully parsed a patch.',
                              `We now have ${parsed_patches.length}/${parsed_headers.patches}`)
            }

            if (input_buffer[0] === '\n' && input_buffer[1] === '\n') {
                console.error(input_buffer)
                throw 'bad'
            }
            console.debug("Parsed all patches.")
            return true
        }
    }
}
