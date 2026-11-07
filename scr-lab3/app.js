

const elBtnLoad = document.getElementById('btn-load')
const elBtnLoad_defaultText = elBtnLoad.textContent
const elPubs = document.getElementById('div-pubs')
const elNewTitle = document.getElementById('inp-title')
const elNewContent = document.getElementById('inp-content')
const elNewUpload = document.getElementById('inp-upload')
const elNewErrors = document.getElementById('inp-errors')
const elLogs = document.getElementById('logs')

const tmpPub = document.getElementById('tmp-pub')

const pubs = [];
const pubsFake = [];    //???

const pubsUpdate = () => {
    elPubs.innerHTML = ''
    console.log(tmpPub)
    for (const pub of pubs) {
        const elPub = tmpPub.content.firstElementChild.cloneNode(true)

        const elTitle = elPub.querySelector('.pub-title')
        elTitle.textContent = pub.title
        const elContent = elPub.querySelector('.pub-content')
        elContent.textContent = pub.body
        elPubs.appendChild(elPub)
    }
    for (const pub of pubsFake) {
        const elPub = tmpPub.content.firstElementChild.cloneNode(true)

        const elTitle = elPub.querySelector('.pub-title')
        elTitle.textContent = pub.title
        const elContent = elPub.querySelector('.pub-content')
        elContent.textContent = pub.body
        elPubs.appendChild(elPub)
    }
}

const fetchPubs = async () => {
    const response = await fetch('https://jsonplaceholder.typicode.com/posts?_limit=5')

    if (!response.ok) {
        elBtnLoad.textContent = 'Что-то пошло не так...'
        elLogs.textContent += `\n> Ошибка ${response.status}`
        elBtnLoad.disabled = false
        return
    }

    const json = await response.json()

    elLogs.textContent += `\n> Успех! Получено ${json.length} записей`

    elBtnLoad.textContent = elBtnLoad_defaultText
    elBtnLoad.disabled = false
    pubs.length = 0
    pubs.push(...json)

    pubsUpdate()
}

const fetchPost = async (body) => {
    const response = await fetch('https://jsonplaceholder.typicode.com/posts', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    })

    if (!response.ok) {
        elNewUpload.textContent = 'Что-то пошло не так...'
        elLogs.textContent += `\n> Ошибка ${response.status}`
        elNewUpload.disabled = false
        return
    }

    const json = await response.json()

    elLogs.textContent += `\n> Успех! Запись ${json.title} загружена с ID ${json.id}`
    console.log(json)
    pubsFake.push(json)
    pubsUpdate()
}

window.onload = () => {
    elBtnLoad.addEventListener('click', () => {
        elBtnLoad.textContent = 'Загрузка...'
        elBtnLoad.disabled = true

        fetchPubs()
    })

    elNewUpload.addEventListener('click', () => {
        //validate
        elNewErrors.textContent = ''

        const valTitle = elNewTitle.value.trim()
        const valContent = elNewContent.value.trim()

        if (valTitle === '') {
            elNewErrors.textContent = 'Заголовок не может быть пустым!'
            return
        }

        if (valContent === '') {
            elNewErrors.textContent = 'Содержимое не может быть пустым!'
            return
        }

        //all ok
        elNewUpload.disabled = true
        const body = {
            userId: 1,
            title: valTitle,
            body: valContent
        }

        fetchPost(body).then(() => {elNewUpload.disabled = false})
    })
}