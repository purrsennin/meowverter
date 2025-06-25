import express from 'express';
import bytes from 'bytes';
import util from 'util';
import cp from 'child_process';
import fs from 'fs';
import os from 'os';
import sharp from 'sharp';
import PDFDocument from 'pdfkit';

const tmpDir = os.tmpdir();
const app = express();

const utils = {
	formatSize: (n) => bytes(+n, { unitSeparator: ' ' }),
	randomName: (ext = '') => Math.random().toString(36).slice(2) + ext,
	isBase64: (str) => {
		try {
			return btoa(atob(str)) === str
		} catch {
			return false
		}
	},
	toPDF: async (urls, opts = {}) => {
		const doc = new PDFDocument({ margin: 0, size: 'A4' })
		const buffs = []

		for (const url of urls) {
			if (!/https?:\/\//.test(url)) continue
			const res = await fetch(url)
			if (!res.ok) continue
			const type = res.headers.get('content-type')
			if (!type.startsWith('image/')) continue

			let image = Buffer.from(await res.arrayBuffer())
			if (/(gif|webp)$/.test(type)) image = await sharp(image).png().toBuffer()

			doc.image(image, 0, 0, {
				fit: [595.28, 841.89],
				align: 'center',
				valign: 'center',
				...opts
			})
			doc.addPage()
		}

		doc.on('data', chunk => buffs.push(chunk))
		return await new Promise((resolve, reject) => {
			doc.on('end', () => resolve(Buffer.concat(buffs)))
			doc.on('error', reject)
			doc.end()
		})
	},
	webpToPng: async (base64) => {
		const buffer = await sharp(Buffer.from(base64, 'base64')).png().toBuffer()
		const filename = utils.randomName('.png')
		const filepath = `${tmpDir}/${filename}`
		await fs.promises.writeFile(filepath, buffer)
		return filepath
	},
	mp4ToAudio: async (inputBase64, format = 'mp3') => {
		const input = `${tmpDir}/${utils.randomName('.mp4')}`
		const output = input.replace('.mp4', `.${format}`)
		await fs.promises.writeFile(input, Buffer.from(inputBase64, 'base64'))

		const exec = util.promisify(cp.exec)
		await exec(`ffmpeg -y -i ${input} ${output}`)
		return output
	}
}

app.set('json spaces', 4);
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));
app.use(favicon(path.join(import.meta.dirname, 'favicon.ico')));
app.use(morgan('combined'));

app.use((req, __, next) => {
	// clear tmp
	/*
	for (let file of fs.readdirSync(tmpDir)) {
		file = `${tmpDir}/${file}`
		const stat = fs.statSync(file)
		const exp = Date.now() - stat.mtimeMs >= 1000 * 60 * 30
		if (stat.isFile() && exp) {
			console.log('Deleting file', file)
			fs.unlinkSync(file)
		}
	}
	*/
	req.allParams = Object.assign(req.query, req.body)
	next()
})

app.use('/file', express.static(tmpDir))

app.all('/', (_, res) => {
	const status = {}
	status['diskUsage'] = cp.execSync('du -sh').toString().split('\t')[0]

	const used = process.memoryUsage()
	for (let x in used) status[x] = utils.formatSize(used[x])

	const totalmem = os.totalmem()
	const freemem = os.freemem()
	status['memoryUsage'] = `${utils.formatSize(totalmem - freemem)} / ${utils.formatSize(totalmem)}`

	const id = process.env.SPACE_ID

	const path = [
		'/webp2mp4',
		'/webp2gif',
		'/webp2png',
		'/topdf',
		'/mp4tomp3',
		'/mp4towav'
	]

	res.json({
		message: id
			? `Go to https://hf.co/spaces/${id}/discussions for discuss`
			: 'Hello World!',
		owner: `https://github.com/purrsennin`,
		uptime: new Date(process.uptime() * 1000).toUTCString().split(' ')[4],
		path,
		status
	})
})

app.post(/^\/mp4to(mp3|wav)/, async (req, res) => {
	try {
		const { file, json, raw } = req.body
		if (!file) return res.status(400).json({ success: false, message: "'file' (base64) is required" })
		if (!utils.isBase64(file)) return res.status(400).json({ success: false, message: 'Invalid base64 format' })

		const format = req.params[0]
		const resultPath = await utils.mp4ToAudio(file, format)
		const resultUrl = `https://${req.hostname}/file/${path.basename(resultPath)}`

		utils.isTrue(json)
			? res.json({ success: true, result: resultUrl })
			: res[utils.isTrue(raw) ? 'send' : 'redirect'](resultUrl)
	} catch (e) {
		console.log(e)
		res.status(500).json({ success: false, message: e.message })
	}
})

app.all(/^\/webp2(gif|mp4|png)/, async (req, res) => {
	if (req.method !== 'POST')
		return res
			.status(405)
			.json({ success: false, message: 'Method Not Allowed' })

	try {
		const { file, json, raw } = req.body
		if (!file)
			return res.status(400).json({
				success: false,
				message: "Payload 'file' requires base64 string"
			})
		if (!utils.isBase64(file))
			return res
				.status(400)
				.json({ success: false, message: 'Invalid base64 format' })

		const type = req.params[0]
		if (type === 'png') {
			const fileName = utils.randomName('.png')
			const fileBuffer = await sharp(Buffer.from(file, 'base64'))
				.png()
				.toBuffer()
			await fs.promises.writeFile(`${tmpDir}/${fileName}`, fileBuffer)

			const resultUrl = `https://${req.hostname}/file/${fileName}`
			utils.isTrue(json)
				? res.json({ success: true, result: resultUrl })
				: res[utils.isTrue(raw) ? 'send' : 'redirect'](resultUrl)
			return
		}

		const fileName = utils.randomName('.webp')
		const filePath = `${tmpDir}/${fileName}`
		await fs.promises.writeFile(filePath, Buffer.from(file, 'base64'))

		const exec = util.promisify(cp.exec).bind(cp)
		await exec(`convert ${filePath} ${filePath.replace('webp', 'gif')}`)

		let resultUrl
		if (type === 'gif')
			resultUrl = `https://${req.hostname}/file/${fileName.replace('webp', 'gif')}`
		else {
			await exec(
				`ffmpeg -i ${filePath.replace('webp', 'gif')} -movflags faststart -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" ${filePath.replace('webp', 'mp4')}`
			)
			resultUrl = `https://${req.hostname}/file/${fileName.replace('webp', 'mp4')}`
		}

		utils.isTrue(json)
			? res.json({ success: true, result: resultUrl })
			: res[utils.isTrue(raw) ? 'send' : 'redirect'](resultUrl)
	} catch (e) {
		console.log(e)
		res.status(500).json({ error: true, message: utils.getError(e) })
	}
})

app.all('/topdf', async (req, res) => {
	if (req.method !== 'POST')
		return res
			.status(405)
			.json({ success: false, message: 'Method Not Allowed' })

	try {
		const { images: urls, json, raw } = req.body
		if (!urls)
			return res.status(400).json({
				success: false,
				message: "Payload 'images' requires an array of urls"
			})
		if (!Array.isArray(urls)) urls = [urls]

		const bufferPDF = await utils.toPDF(urls)
		if (!bufferPDF.length)
			return res
				.status(400)
				.json({ success: false, message: "Can't convert to pdf" })

		const fileName = utils.randomName('.pdf')
		await fs.promises.writeFile(`${tmpDir}/${fileName}`, bufferPDF)

		const resultUrl = `https://${req.hostname}/file/${fileName}`
		utils.isTrue(json)
			? res.json({ success: true, result: resultUrl })
			: res[utils.isTrue(raw) ? 'send' : 'redirect'](resultUrl)
	} catch (e) {
		console.log(e)
		res.status(500).json({ error: true, message: utils.getError(e) })
	}
})

// app.use((req, res, next) => {})

const PORT = process.env.PORT || 7860
app.listen(PORT, () => console.log(`App running on port ${PORT}`))
